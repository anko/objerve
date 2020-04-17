const arrayKeyedMap = require('array-keyed-map')
const deepObjectDiff = require('deep-object-diff').detailedDiff
const consoleModule = require('console')

const rootOfProxy = new WeakMap()
const pathOfProxy = new WeakMap()

const proxy = (obj, rootArg, path=[]) => {
  // Primitive values can't have properties, so need no wrapper.
  if (!isObject(obj)) return obj

  // If the value is itself a proxy, subscribe to changes on that object, and
  // call appropriately edited updates on us when paths on it change.  Also
  // subscribe to this property on ourselves, so we can clean up both listeners
  // if our property changes.
  if (rootOfProxy.has(obj)) {

    // If this is a reference to ourselves, just return it.  It's equivalent.
    if (rootOfProxy.get(obj) === rootArg) return obj

    const prefixesToIgnore = arrayKeyedMap()
    const subRoot = rootOfProxy.get(obj)
    const subPath = pathOfProxy.get(obj)
    const prefixListener = (newValue, oldValue, action, changePath, obj) => {
      changePath = changePath.slice(subPath.length)
      DEBUG('sub-root', 'changed', {subRoot, changePath})
      let doFullUpdate = true

      // If the subRoot we're observing at this path has a reference to us, we
      // want to ignore that property now and in the future, until it changes
      // to something else.  If we didn't do this, we'd risk looping
      // infinitely:  We have a reference to them, and they to us.
      if (rootOfProxy.get(newValue) === rootArg) {
        DEBUG('sub-root', 'adding to ignore list', {subRoot, changePath})
        prefixesToIgnore.set(changePath, true)
        doFullUpdate = false
      } else if (prefixesToIgnore.has(changePath)) {
        DEBUG('sub-root', 'ignoring', {subRoot, changePath})
        // If it has changed to a new value, stop ignoring it
        if (rootOfProxy.get(newValue) !== rootArg) {
          DEBUG('sub-root', 'removing from ignore list', {subRoot, changePath})
          prefixesToIgnore.delete(changePath)
        } else {
          // Might have changed to another thing that is a reference to us.
          // Continue ignoring, but allow a shallow update, so listeners for
          // that path exactly can see it changed.
          doFullUpdate = false
        }
      } else {
        if (allPrefixes(changePath).some((x) => prefixesToIgnore.has(x))) {
          // This is some sub-property within the property we want to ignore.
          // Return without triggering any listener updates at all.
          return
        }
      }

      const finalPath = path.concat(changePath)
      if (doFullUpdate) {
        update(rootArg, action, finalPath, oldValue, newValue)
      } else {
        shallowUpdate(rootArg, action, finalPath, oldValue, newValue)
      }
    }
    DEBUG('sub-root', 'prefix-listening to', {subRoot})
    addPrefixListener(subRoot, [], prefixListener)

    const propertyListener = (newValue, oldValue, action, path, _) => {
      if (newValue !== obj) {
        DEBUG('sub-root', 'own path changed; unlistening', {path})
        removeListener(rootArg, path, propertyListener)
        removePrefixListener(subRoot, [], prefixListener)
      }
    }
    DEBUG('sub-root', 'listening to own path', {path})
    addListener(rootArg, path, propertyListener)

    // Iterate through the object in case it already has properties that are
    // references to us, so we can pre-emptively add those to the ignore list.
    visitProperties(obj, (path, val) => {
      if (rootOfProxy.get(val) === rootArg) {
        prefixesToIgnore.set(path, true)
        DEBUG('sub-root', rootArg, ': pre-adding to ignore list', {obj, path})
        return false
      } else return true
    })

    return obj
  }

  // Everything beyond this point handles proxying Objects that have
  // properties.

  let root

  // If we are proxying an Array, and the contents change, our 'set' handler
  // will get called first with all the content 'set's, and finally with a
  // 'length' set.
  //
  // This means when we try to handle the 'length' set, we cannot directly
  // access the previous 'length' value in 'o.length', because the array
  // contents have already changed, so 'o.length' is just the same value as
  // it's now being set to!
  //
  // We solve this by storing the length ourselves of any Array we see, and
  // using that as the 'oldValue' next time a length 'set' comes along.
  const arrayLengthCache = new WeakMap()

  // If a user callback modifies the path, we want to give it priority, and not
  // overwrite its value immediately after.  Hence this 'updateListeners'
  // wrapper around bare 'update'.
  //
  // All it does in addition is maintain the 'proxyHitCache' so it knows which
  // paths an update changed, and can therefore report to its caller whether
  // the user's listeners also changed the property that they were notified of
  // a change for.  The caller can then choose to avoid overwriting the user's
  // change with the new incoming value.
  const proxyHitCache = new Map()
  let nextId = 0
  const updateListeners = (...args) => {
    const localPath = args[2]

    // For all cache entries that are active, note that this path was modified.
    for (let v of proxyHitCache.values()) { v.set(localPath, true) }

    // Make our own cache entry to track modified paths
    const id = nextId++
    proxyHitCache.set(id, arrayKeyedMap())

    // Call update (which possibly runs user callbacks)
    update(...args)

    // Check if user code changed it
    const somethingChanged = proxyHitCache.get(id).has(localPath)

    // Clear our hit cache entry
    proxyHitCache.delete(id)

    return { listenerChangedValue: somethingChanged }
  }

  const node = new Proxy(obj, {
    set: (o, key, value) => {
      let localPath = path.concat([key])
      value = proxy(value, root, localPath)
      let oldValue = o[key]

      if (o instanceof Array) {
        if (key === 'length') {
          // Call listeners for any values that got truncated.
          for (let i = value; i < oldValue; ++i) {
            const indexPath = localPath.slice(0, -1).concat([String(i)])
            const args = [root, 'delete', indexPath, o[i], undefined]
            const {listenerChangedValue} = updateListeners(...args)
            if (!listenerChangedValue) o.length = value
          }
          // Use the old array length value from the cache.
          oldValue = arrayLengthCache.get(o)
        }
        // Update length cache entry.
        arrayLengthCache.set(o, o.length)
      }

      const args = [root, 'set', localPath, oldValue, value]
      const {listenerChangedValue} = updateListeners(...args)
      if (!listenerChangedValue) o[key] = value

      return true // Indicate success
    },
    deleteProperty: (o, key) => {
      let localPath = path.concat([key])

      const args = [root, 'delete', localPath, o[key], undefined]
      const {listenerChangedValue} = updateListeners(...args)
      if (!listenerChangedValue) delete o[key]

      return true // Indicate success
    },
  })

  // If we didn't get a root passed in, we're the root
  root = rootArg || node

  rootOfProxy.set(node, root)
  pathOfProxy.set(node, path)

  // Proxy the contents
  for (const key of Object.getOwnPropertyNames(obj)) {
    obj[key] = proxy(obj[key], root, path.concat([key]))
  }

  return node
}

const proxyBase = (template={}) => {
  if (rootOfProxy.has(template)) return template
  const p = proxy(template)
  listenersForRoot.set(p, arrayKeyedMap())
  return p
}

// root -> (path -> [function])
const listenersForRoot = new WeakMap()

// Each property update (i.e. creation, change, or deletion) gets a unique ID,
// which is passed to all of the callbacks fired by that update.  To account
// for recursive calls too, we hold on to an "ongoing update id" that once set
// will apply to everything until revoked.
const updateId = (() => {
  let ongoingUpdateId = null
  let nextUpdateId = 0

  const get = () => {
    if (ongoingUpdateId === null) {
      ongoingUpdateId = nextUpdateId++
      DEBUG('update id', `${ongoingUpdateId} (NEW)`)
    } else DEBUG('update id', `${ongoingUpdateId}`)
    return ongoingUpdateId
  }

  const revoke = () => { ongoingUpdateId = null }

  return { get, revoke }
})()

const callListeners = (root, action,
    listenerPath, propertyPath, oldValue, newValue, upid) => {

  if (action === 'set') {
    if (hasPath(root, propertyPath)) {
      // Have it previously
      action = 'change'
    } else {
      action = 'create'
    }
  }

  propertyPath = propertyPath.map((x) => isArrayIndex(x) ? Number(x) : x)

  const pathListeners = listenersForRoot.get(root)
  if (pathListeners.has(listenerPath)) {
    for (const listener of pathListeners.get(listenerPath)) {
      listener(newValue, oldValue, action, propertyPath, root, upid)
    }
  }
}

const shallowUpdate = (root, action, path, oldValue, newValue) => {
  // Call listeners for this path only, without trying to be clever and
  // accounting for sub-properties and everything.  This should only be called
  // in preference to the usual 'update' to avoid looping infinitely when it's
  // known that the sub-properties would contain cyclic references, and their
  // updating is already otherwise accounted for.

  const sortOrder = action === 'set' ? SORT.TRUNK_FIRST : SORT.LEAF_FIRST
  const pathListeners = listenersForRoot.get(root)

  let listenerPaths = generalisePath(path)

  let upid = updateId.get()
  for (const listenerPath of listenerPaths) {
    callListeners(root, action, listenerPath, path,
      oldValue,
      newValue,
      upid)
  }
  updateId.revoke()
}

const update = (root, action, path, oldValue, newValue) => {

  const oldIsPrimitive = !isObject(oldValue)
  const newIsPrimitive = !isObject(newValue)

  const sortOrder = action === 'set' ? SORT.TRUNK_FIRST : SORT.LEAF_FIRST

  if (oldIsPrimitive && newIsPrimitive) {
    DEBUG('update strategy', path, oldValue, "primitive -> primitive", newValue)
    // Both primitives.  Just call the listener for this path.
    const pathListeners = listenersForRoot.get(root)

    const matchingPaths = getAllMatchingPaths(
      newValue, pathListeners, path, sortOrder)
    let upid = updateId.get()
    for (const {listenerPath, propertyPath} of matchingPaths) {
      const pathRelative = propertyPath.slice(path.length)
      callListeners(root, action, listenerPath, propertyPath,
        oldValue,
        newValue,
        upid)
    }
    updateId.revoke()

  } else if (oldIsPrimitive && !newIsPrimitive) {
    DEBUG('update strategy', path, oldValue, "primitive -> object", newValue)
    // Primitive being overwritten with an Object.  Call listeners for every
    // relevant path in the new object.
    const pathListeners = listenersForRoot.get(root)

    let upid = updateId.get()

    // Call listeners for changed property
    ;(() => {
      const matchingPaths = generalisePath(path, SORT.TRUNK_FIRST).map((x) => {
        return { listenerPath: x, propertyPath: path }
      })
      for (const {listenerPath, propertyPath} of matchingPaths) {
        callListeners(root, action, listenerPath, propertyPath,
          oldValue,
          newValue,
          upid)
      }
    })()

    // Call listeners for properties within that new object
    ;(() => {
      for (const k of Object.getOwnPropertyNames(newValue)) {
        const matchingPaths = getAllMatchingPaths(
          newValue[k], pathListeners, path.concat([k]), SORT.TRUNK_FIRST)
        for (const {listenerPath, propertyPath} of matchingPaths) {
          const pathRelative = propertyPath.slice(path.length)
          callListeners(root, 'create', listenerPath, propertyPath,
            getPath(root, propertyPath),
            getPath(newValue, pathRelative),
            upid)
        }
      }
    })()

    updateId.revoke()

  } else if (!oldIsPrimitive && newIsPrimitive) {
    DEBUG('update strategy', path, oldValue, "object -> primitive", newValue)
    // Object being overwritten with a primitive value.  Call listeners for
    // every relevant path in the old object.
    const pathListeners = listenersForRoot.get(root)

    let upid = updateId.get()

    // Call listeners for now-deleted properties
    ;(() => {
      for (const k of Object.getOwnPropertyNames(oldValue)) {
        const matchingPaths = getAllMatchingPaths(
          oldValue[k], pathListeners, path.concat([k]), SORT.LEAF_FIRST)
        for (const {listenerPath, propertyPath} of matchingPaths) {
          callListeners(root, 'delete', listenerPath, propertyPath,
            getPath(root, propertyPath),
            undefined,
            upid)
        }
      }
    })()

    // Call listeners for changed property
    ;(() => {
      const matchingPaths = generalisePath(path, SORT.TRUNK_FIRST).map((x) => {
        return { listenerPath: x, propertyPath: path }
      })
      for (const {listenerPath, propertyPath} of matchingPaths) {
        callListeners(root, action, listenerPath, propertyPath,
          oldValue,
          newValue,
          upid)
      }
    })()

    updateId.revoke()

  } else {
    DEBUG('update strategy', path, oldValue, "object -> object", newValue)
    const pathListeners = listenersForRoot.get(root)

    let upid = updateId.get()
    // Call listeners for this path that the object is being assigned to.
    ;(() => {
      const matchingPaths = generalisePath(path, SORT.TRUNK_FIRST).map((x) => {
        return { listenerPath: x, propertyPath: path }
      })
      for (const {listenerPath, propertyPath} of matchingPaths) {
        callListeners(root, action, listenerPath, propertyPath,
          oldValue,
          newValue,
          upid)
      }
    })()

    // Diff the old and new objects and call listeners for all the relevant
    // paths that were added, updated, or deleted.
    const {added, updated, deleted} = diffObjects(oldValue, newValue)

    ;(() => {
      // Handle added
      const matchingPaths = getAllMatchingPaths(
        added, pathListeners, path, SORT.TRUNK_FIRST)
      for (const {listenerPath, propertyPath} of matchingPaths) {
        const pathRelative = propertyPath.slice(path.length)
        if (pathRelative.length === 0) continue
        callListeners(root, 'set', listenerPath, propertyPath,
          getPath(root, propertyPath),
          getPath(added, pathRelative),
          upid)
      }
    })()

    ;(() => {
      // Handle updated
      const matchingPaths = getAllMatchingPaths(
        updated, pathListeners, path, SORT.TRUNK_FIRST)
      for (const {listenerPath, propertyPath} of matchingPaths) {
        const pathRelative = propertyPath.slice(path.length)
        if (pathRelative.length === 0) continue
        callListeners(root, 'set', listenerPath, propertyPath,
          getPath(root, propertyPath),
          getPath(updated, pathRelative),
          upid)
      }
    })()

    ;(() => {
      // Handle deleted
      //
      // A deleted property may have been an object with properties, and the
      // diff only shows the topmost level that got deleted.  We want every
      // deleted property's full path though, so we can call its listeners to
      // inform of their deletion.
      const deletedProperties = Object.getOwnPropertyNames(deleted)

      for (const deletedProp of deletedProperties) {
        const matchingPaths = getAllMatchingPaths(
          getPath(root, path.concat([deletedProp])),
          pathListeners,
          path.concat([deletedProp]),
          SORT.LEAF_FIRST)

        for (const {listenerPath, propertyPath} of matchingPaths) {
          const pathRelative = propertyPath.slice(path.length)
          if (pathRelative.length === 0) continue
          callListeners(root, 'delete', listenerPath, propertyPath,
            getPath(root, propertyPath),
            undefined,
            upid)
        }
      }
    })()
    updateId.revoke()
  }
}

const wrapperOfCallback = new WeakMap()

const addListener = (obj, path, func) => {
  if (!rootOfProxy.has(obj)) {
    throw TypeError(`Not an objerve instance: ${JSON.stringify(obj)}`)
  }
  if (!(path instanceof Array)) {
    throw TypeError(`Invalid path: ${JSON.stringify(path)}`)
  }
  if (!(func instanceof Function)) {
    throw TypeError(`Invalid callback function: ${JSON.stringify(path)}`)
  }

  // Convert path elements to strings for internal consistency.  A string that
  // looks like a number is equivalent to that number when used as a property
  // name, and we use this representation.
  path = path.map((x) => typeof x === 'number' ? String(x) : x)

  // The object 'obj' we are being asked to listen to may actually be a proxied
  // object that is a subproperty of an objerve root object.  We can only
  // subscribe to its root, but if we did that, the callback would be called
  // with an absolute path from the root, which a user wouldn't expect.
  //
  // For this reason, we have to create a wrapper function that massages the
  // path and value passed to the user's callback, such that they are relative
  // to the subproperty object that they called addListener on.
  const root = rootOfProxy.get(obj)
  const subPath = pathOfProxy.get(obj)
  const wrapperFunction = (newVal, oldVal, action, path, objRef, updateId) => {
    func(newVal, oldVal, action,
      path.slice(subPath.length),
      getPath(objRef, subPath),
      updateId)
  }
  wrapperOfCallback.set(func, wrapperFunction)

  // If 'obj' is actually a root, then subPath will be an empty array, and this
  // concat effectively does nothing.
  path = subPath.concat(path)

  const listenersForPath = listenersForRoot.get(root)
  if (!listenersForPath.has(path)) {
    listenersForPath.set(path, [])
  }
  listenersForPath.get(path).push(wrapperFunction)
}
const removeListener = (root, path, func) => {
  const listenersForPath = listenersForRoot.get(root)
  if (listenersForPath.has(path)) {
    const listeners = listenersForPath.get(path)
    const wrapperFunc = wrapperOfCallback.get(func)
    // Splice it out
    removeByValue(listeners, wrapperFunc)
    // If there are now none left for this path, delete the path
    if (listeners.length === 0) {
      listenersForPath.delete(path)
    }
  }
}

const addPrefixListener = (root, path, func) => {
  path = path.concat([TREE])
  addListener(root, path, func)
}
const removePrefixListener = (root, path, func) => {
  path = path.concat([TREE])
  removeListener(root, path, func)
}

const generalisePath = (path, sortOrder) => {
  // Generalise this path, creating every possible listener path that could
  // match it.  More specifically:
  //
  // - Letting array indexes be themselves or 'EACH'
  // - Letting the path terminate with 'TREE' anywhere including root

  let paths = []
  if (sortOrder === SORT.TRUNK_FIRST) paths.push([TREE])
  switch (path.length) {
    case 1:
      const elem = path[0]
      if (sortOrder === SORT.TRUNK_FIRST) {
        if (isArrayIndex(elem)) paths.push([EACH])
        paths.push([elem])
      } else {
        paths.push([elem])
        if (isArrayIndex(elem)) paths.push([EACH])
      }
      break
    default:
      const [head, ...rest] = path
      for (let x of generalisePath([head], sortOrder)) {
        // A 'TREE' symbol always terminates a listener path anyway, so don't
        // bother searching after it.
        if (last(x) === TREE) continue
        for (let y of generalisePath(rest, sortOrder)) {
          paths.push(x.concat(y))
        }
      }
      break
  }
  if (sortOrder !== SORT.TRUNK_FIRST) paths.push([TREE])
  return paths
}

const EACH = Symbol('objerve [each]')
const TREE = Symbol('objerve [tree]')
const SORT = {
  TRUNK_FIRST: Symbol('sort order: trunk → leaf'),
  LEAF_FIRST: Symbol('sort order: leaf → trunk'),
}
const getAllMatchingPaths = (obj, akmap, pathPrefix, sortOrder, listenerPathPrefix, seenObjects) => {
  // Get all paths in the object that the given array-keyed-map also has paths
  // for.  The akmap is passed so that we can prune the search, and avoid
  // listing path branches we don't even have a subscriber for.
  //
  // Because of aliases like the EACH symbol (which matches any array index),
  // it may be necessary to generalise and return multiple listener paths for
  // each property path.

  // In order to detect cyclical references, we track what objects we've seen
  // already in this path.  This way we can exit out early if we see one again;
  // following it would lead us to loop infinitely.
  seenObjects = seenObjects || []

  // On initial call, fully generalise the property path we've gotten, and
  // return a join of all recursive calls with every possible interpretation.
  if (!listenerPathPrefix) {
    const listenerPathPrefixes = generalisePath(pathPrefix, sortOrder)
    return listenerPathPrefixes.reduce((prev, next) => {
      return prev.concat(
        getAllMatchingPaths(obj, akmap, pathPrefix, sortOrder, next, seenObjects))
    }, [])
  }

  if (rootOfProxy.has(obj)) {
    if (seenObjects.includes(obj)) {
      return []
    } else {
      seenObjects = seenObjects.concat([obj])
    }
  }

  DEBUG('matching paths', {obj, akmap: Array.from(akmap.entries()),
    pathPrefix, sortOrder, listenerPathPrefix,
    hasPrefix: akmap.hasPrefix(listenerPathPrefix),
    seenObjects})

  if (!akmap.hasPrefix(listenerPathPrefix)) {
    // We don't have any listeners with this prefix.  Exit early.
    return []
  } else {
    // We have something somewhere with this prefix.  Explore further.
    let paths = []

    // First declare how visiting the current node and children works, then
    // call them depending on the given sort order.

    const visitTrunk = () => {
      if (akmap.has(listenerPathPrefix)) {
        paths.push({
          propertyPath: pathPrefix,
          listenerPath: listenerPathPrefix,
        })
      }
    }

    const visitLeaves = () => {
      if (isObject(obj)) {
        for (const key of Object.getOwnPropertyNames(obj)) {

          // When calling recursively for children, extend the
          // listenerPathPrefix with a possible property key, unless it
          // terminates with TREE; in those cases we still want to extend
          // pathPrefix, but leave the listenerPathPrefix as-is, so the same
          // prefix listener gets called for everything under it.

          // Explore the usual property branch.
          const listenerPath = last(listenerPathPrefix) === TREE
            ? listenerPathPrefix
            : listenerPathPrefix.concat([key])
          paths.push(...getAllMatchingPaths(
            obj[key], akmap,
            pathPrefix.concat([key]),
            sortOrder,
            listenerPath,
            seenObjects))

          if (isArrayIndex(key)) {
            // This is an array index.  Also explore the EACH branch.
            const listenerPath = last(listenerPathPrefix) === TREE
              ? listenerPathPrefix
              : listenerPathPrefix.concat([EACH])
            paths.push(...getAllMatchingPaths(
              obj[key], akmap,
              pathPrefix.concat([key]),
              sortOrder,
              listenerPath,
              seenObjects))
          }
        }
      }
    }

    switch (sortOrder) {
      case SORT.LEAF_FIRST:
        visitLeaves()
        visitTrunk()
        break
      case SORT.TRUNK_FIRST:
        visitTrunk()
        visitLeaves()
        break
      default:
        throw new Error(`Invalid sort order: ${sortOrder}`)
    }

    return paths
  }
}

const last = (arr) => arr[arr.length - 1]

const hasPath = (obj, path) => {
  if (!isObject(obj)) return false
  switch (path.length) {
    case 0:
      return true
    case 1:
      return path[0] in obj
    default:
      let [head, ...rest] = path
      // The path is an array of keys to be used sequentially as properties
      if (head in obj) {
        return hasPath(obj[head], rest)
      } else {
        return false
      }
  }
}

const getPath = (obj, path) => {
  switch (path.length) {
    case 0:
      return obj
    case 1:
      return obj[path[0]]
    default:
      let [head, ...rest] = path
      // The path is an array of keys to be used sequentially as properties
      if (head in obj) {
        return getPath(obj[head], rest)
      } else {
        return undefined
      }
  }
}

const diffObjects = (oldValue, newValue) => {
  oldValue = isObject(oldValue) ? oldValue : {}
  newValue = isObject(newValue) ? newValue : {}

  const {added, deleted, updated} = deepObjectDiff(oldValue, newValue)

  // The deep-object-diff module doesn't consider Array "length" properties,
  // but we want those, so we have to change the diff to add that ourselves.
  //
  // We also consider an Object's "length" property the same thing.  If we
  // didn't, then changing an Array to an Object with a "length" property that
  // happens to contain the same number as the length of the array would give a
  // really nonsensical diff (e.g. imagine changing [42] to { length: 1 }).

  const previousHasLength = existsAndHasProperty(oldValue, 'length')
  const newHasLength = existsAndHasProperty(newValue, 'length')
  if (previousHasLength && newHasLength) {
    delete added.length
    delete deleted.length
    if (oldValue.length !== newValue.length)
      updated.length = newValue.length
  } else if (!previousHasLength && newHasLength) {
    delete updated.length
    delete deleted.length
    added.length = newValue.length
  } else if (previousHasLength && !newHasLength) {
    delete added.length
    delete updated.length
    deleted.length = undefined
  }

  return {added, deleted, updated}
}

const existsAndHasProperty = (x, key) => {
  return isObject(x) && (key in x)
}

const removeByValue = (arr, val) => {
  const index = arr.indexOf(val)
  if (index < 0) return
  arr.splice(index, 1)
}

const allPrefixes = (arr) => {
  const prefixes = []
  for (let i = 0; i < arr.length; ++i) {
    prefixes.push(arr.slice(0, i))
  }
  return prefixes
}

const visitProperties = (obj, callback, path=[]) => {
  // Recursively visit properties of 'obj', calling the callback for each and
  // letting itdecide with its return value whether to continue 'true' or prune
  // that branch 'false'.
  let mayContinue
  mayContinue = callback(path, obj)
  if (mayContinue) {
    for (let key of Object.getOwnPropertyNames(obj)) {
      const pathHere = path.concat([key])
      mayContinue = callback(pathHere, obj[key])
      if (mayContinue && isObject(obj[key])) {
        visitProperties(obj[key], callback, pathHere)
      }
    }
  }
}

const isObject = (x) => x instanceof Object

const isArrayIndex = (x) => x.match(/^[0-9]+$/) ? true : false

const DEBUG = (() => {
  // Uncomment a string here to enable that type of debug logging
  const activeDebugTypes = new Set([
    // 'update strategy',
    // 'update id',
    // 'sub-root',
    // 'matching paths',
  ])
  // Same as regular console, but always log full depth.  Default console.log
  // will annoyingly truncate at some point.
  const debugConsole = new console.Console({
    stdout: process.stdout,
    stderr: process.stderr,
    inspectOptions: {depth: null},
  })
  return (type, ...values) => {
    if (activeDebugTypes.has(type)) {
      // Using ANSI colours to make the debug header easier to notice
      const reverse = process.stdout.isTTY ? '\x1b[7m' : ''
      const magenta = process.stdout.isTTY ? '\x1b[35m' : ''
      const reset = process.stdout.isTTY ? '\x1b[0m' : ''
      debugConsole.log(`${magenta}${reverse}DEBUG${reset} `
        + `${magenta}${type}${reset}:`, ...values)
    }
  }
})()

module.exports = proxyBase
proxyBase.addListener = addListener
proxyBase.removeListener = removeListener
proxyBase.addPrefixListener = addPrefixListener
proxyBase.removePrefixListener = removePrefixListener
proxyBase.each = EACH
