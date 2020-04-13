const akm = require('array-keyed-map')
const deepObjectDiff = require('deep-object-diff').detailedDiff

const debug = () => {}
debug['active'] = console.log

const proxy = (obj, rootArg, path=[]) => {
  // Primitive values can't have properties, so need no wrapper.
  if (!isObjectOrArray(obj)) return obj

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
            update(...args)
            o.length = value
          }
          // Use the old array length value from the cache.
          oldValue = arrayLengthCache.get(o)
        }
        // Update length cache entry.
        arrayLengthCache.set(o, o.length)
      }

      const args = [root, 'set', localPath, oldValue, value]

      update(...args)
      Reflect.set(o, key, value)
      return true // Indicate success
    },
    deleteProperty: (o, key) => {
      let localPath = path.concat([key])
      const args = [root, 'delete', localPath, o[key], undefined]

      update(...args)
      Reflect.deleteProperty(o, key)
      return true // Indicate success
    },
  })

  // If we didn't get a root passed in, we're the root
  root = rootArg || node

  // Proxy the contents
  for (const key of Object.getOwnPropertyNames(obj)) {
    obj[key] = proxy(obj[key], root, path.concat([key]))
  }

  return node
}

const proxyBase = (template={}) => {
  const p = proxy(template)
  listenersForRoot.set(p, akm())
  return p
}

// root -> (path -> [function])
const listenersForRoot = new WeakMap()

const callListeners = (root, action,
    listenerPath, propertyPath, oldValue, newValue) => {
  debug({root, action, listenerPath, propertyPath, oldValue, newValue})

  if (action === 'set') {
    if (hasPath(root, propertyPath)) {
      // Have it previously
      action = 'change'
    } else {
      action = 'create'
    }
  }

  const pathListeners = listenersForRoot.get(root)
  if (pathListeners.has(listenerPath)) {
    for (const listener of pathListeners.get(listenerPath)) {
      listener(newValue, oldValue, action, propertyPath, root)
    }
  }
}

const generalisePath = (path) => {
  // Generalise this path, creating every possible listener path that could
  // match it.  This means converting array indexes also into 'EACH', in every
  // available permutation.

  let paths = []
  switch (path.length) {
    case 1:
      const elem = path[0]
      paths.push([elem])
      if (isArrayIndex(elem)) paths.push([EACH])
      break
    default:
      const [head, ...rest] = path
      for (let x of generalisePath([head])) {
        for (let y of generalisePath(rest)) {
          paths.push(x.concat(y))
        }
      }
      break
  }
  return paths
}

const EACH = Symbol('objerve [each]')
const SORT = {
  TRUNK_FIRST: Symbol('sort order: trunk → leaf'),
  LEAF_FIRST: Symbol('sort order: leaf → trunk'),
}
const getAllMatchingPaths = (obj, akmap, pathPrefix, sortOrder, listenerPathPrefix) => {
  // Get all paths in the object that the given array-keyed-map also has paths
  // for.  The akmap is passed so that we can prune the search, and avoid
  // listing path branches we don't even have a subscriber for.
  //
  // Because of aliases like the EACH symbol (which matches any array index),
  // it may be necessary to generalise and return multiple listener paths for
  // each property path.

  // On initial call, fully generalise the property path we've gotten, and
  // return a join of all recursive calls with every possible interpretation.
  if (!listenerPathPrefix) {
    const listenerPathPrefixes = generalisePath(pathPrefix)
    return listenerPathPrefixes.reduce((prev, next) => {
      return prev.concat(
        getAllMatchingPaths(obj, akmap, pathPrefix, sortOrder, next))
    }, [])
  }

  if (!akmap.hasPrefix(listenerPathPrefix)) {
    // We don't have any listeners with this prefix.  Exit early.
    return []
  } else {
    // We have something somewhere with this prefix.  Explore further.
    let paths = []

    // First declare how visiting the current node and children works, then
    // call them in either order depending on the desired sort order.

    const visitTrunk = () => {
      if (akmap.has(listenerPathPrefix)) {
        paths.push({
          propertyPath: pathPrefix,
          listenerPath: listenerPathPrefix,
        })
      }
    }

    const visitLeaves = () => {
      if (isObjectOrArray(obj)) {
        for (const key of Object.keys(obj)) {
          // Explore the usual property branch.
          paths.push(...getAllMatchingPaths(
            obj[key], akmap,
            pathPrefix.concat([key]),
            sortOrder,
            listenerPathPrefix.concat([key])))
          if (isArrayIndex(key)) {
            // This is an array index.  Also explore the EACH branch.
            paths.push(...getAllMatchingPaths(
              obj[key], akmap,
              pathPrefix.concat([key]),
              sortOrder,
              listenerPathPrefix.concat([EACH])))
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

const hasPath = (obj, path) => {
  if (!isObjectOrArray(obj)) return false
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

const DEBUG_UPDATE_STRATEGY = false

const update = (root, action, path, oldValue, newValue) => {

  const oldIsPrimitive = !isObjectOrArray(oldValue)
  const newIsPrimitive = !isObjectOrArray(newValue)

  debug({root, action, path, oldValue, newValue})

  if (oldIsPrimitive && newIsPrimitive) {
    if (DEBUG_UPDATE_STRATEGY)
      console.log([ path, oldValue, "primitive -> primitive", newValue])
    // Both primitives.  Just call the listener for this path.
    const pathListeners = listenersForRoot.get(root)

    const matchingPaths = getAllMatchingPaths(
      newValue, pathListeners, path, SORT.TRUNK_FIRST)
    for (const {listenerPath, propertyPath} of matchingPaths) {
      const pathRelative = propertyPath.slice(path.length)
      callListeners(root, action, listenerPath, propertyPath,
        oldValue,
        newValue)
    }

  } else if (oldIsPrimitive && !newIsPrimitive) {
    if (DEBUG_UPDATE_STRATEGY)
      console.log([ path, oldValue, "primitive -> object", newValue])
    // Primitive being overwritten with an Object.  Call listeners for every
    // relevant path in the new object.
    const pathListeners = listenersForRoot.get(root)

    const matchingPaths = getAllMatchingPaths(
      newValue, pathListeners, path, SORT.TRUNK_FIRST)
    for (const {listenerPath, propertyPath} of matchingPaths) {
      const pathRelative = propertyPath.slice(path.length)
      callListeners(root, action, listenerPath, propertyPath,
        getPath(root, propertyPath),
        getPath(newValue, pathRelative))
    }

  } else if (!oldIsPrimitive && newIsPrimitive) {
    if (DEBUG_UPDATE_STRATEGY)
      console.log([ path, oldValue, "object -> primitive", newValue])
    // Object being overwritten with a primitive value.  Call listeners for
    // every relevant path in the old object.
    const pathListeners = listenersForRoot.get(root)

    const matchingPaths = getAllMatchingPaths(
      oldValue, pathListeners, path, SORT.LEAF_FIRST)
    for (const {listenerPath, propertyPath} of matchingPaths) {
      callListeners(root, 'delete', listenerPath, propertyPath,
        getPath(root, propertyPath),
        undefined)
    }

  } else {
    if (DEBUG_UPDATE_STRATEGY)
      console.log([ path, oldValue, "object -> object", newValue])
    // Both Objects.  Diff them and call listeners for all the relevant paths.
    const {added, updated, deleted} = diffObjects(oldValue, newValue)
    const pathListeners = listenersForRoot.get(root)

    // Handle added
    ;(() => {
      const matchingPaths = getAllMatchingPaths(
        added, pathListeners, path, SORT.TRUNK_FIRST)
      for (const {listenerPath, propertyPath} of matchingPaths) {
        const pathRelative = propertyPath.slice(path.length)
        if (pathRelative.length === 0) continue
        callListeners(root, 'set', listenerPath, propertyPath,
          getPath(root, propertyPath),
          getPath(added, pathRelative))
      }
    })()

    // Handle updated
    ;(() => {
      const matchingPaths = getAllMatchingPaths(
        updated, pathListeners, path, SORT.TRUNK_FIRST)
      for (const {listenerPath, propertyPath} of matchingPaths) {
        const pathRelative = propertyPath.slice(path.length)
        if (pathRelative.length === 0) continue
        callListeners(root, 'set', listenerPath, propertyPath,
          getPath(root, propertyPath),
          getPath(updated, pathRelative))
      }
    })()

    // Handle deleted
    ;(() => {
      // For each of the deleted properties, find the actual full paths of
      // everything that was under there (the diff summary doesn't show those),
      // and call listeners for their deletion.
      const deletedProperties = Object.keys(deleted)

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
            undefined)
        }

      }
    })()

    ;(() => {
      // In case there is a listener specifically for this path that now
      // contains an object that is being reassigned, let's call that too.

      const matchingPaths = generalisePath(path).map((x) => {
        return { listenerPath: x, propertyPath: path }
      })
      for (const {listenerPath, propertyPath} of matchingPaths) {
        callListeners(root, action, listenerPath, propertyPath,
          oldValue,
          newValue)
      }
    })()

  }
}

const addListener = (root, path, func) => {
  const listenersForPath = listenersForRoot.get(root)
  if (!listenersForPath.has(path)) {
    listenersForPath.set(path, [])
  }
  listenersForPath.get(path).push(func)
}
const removeListener = (root, path, func) => {
  const listenersForPath = listenersForRoot.get(root)
  if (listenersForPath.has(path)) {
    const listeners = listenersForPath.get(path)
    // Splice it out
    removeByValue(listeners, func)
    // If there are now none left for this path, delete the path
    if (listeners.length === 0) {
      listenersForPath.delete(path)
    }
  }
}

const diffObjects = (oldValue, newValue) => {
  oldValue = isObjectOrArray(oldValue) ? oldValue : {}
  newValue = isObjectOrArray(newValue) ? newValue : {}

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
  return isObjectOrArray(x) && (key in x)
}

const removeByValue = (arr, val) => {
  const index = arr.indexOf(val)
  if (index < 0) return
  arr.splice(index, 1)
}

const isObjectOrArray = (x) => x instanceof Object

const isArrayIndex = (x) => x.match(/^[0-9]+$/) ? true : false

module.exports = proxyBase
proxyBase.addListener = addListener
proxyBase.removeListener = removeListener
proxyBase.each = EACH
