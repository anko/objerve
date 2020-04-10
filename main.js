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

  const node = new Proxy(obj, {
    set: (o, key, value) => {
      let localPath = path.concat([key])
      value = proxy(value, root, localPath)
      let actionName = key in o ? 'change' : 'create'
      const oldValue = o[key]

      if ((o instanceof Array) && key === 'length') {
        // Call listeners for any now truncated values.
        for (let i = value; i < oldValue; ++i) {
          const indexPath = localPath.slice(0, -1).concat([String(i)])
          const args = [root, 'delete', indexPath, o[i], undefined]
          updateBefore(...args)
        }
      }

      const args = [root, actionName, localPath, oldValue, value]

      updateBefore(...args)
      Reflect.set(o, key, value)
      updateAfter(...args)
      return true // Indicate success
    },
    deleteProperty: (o, key) => {
      let localPath = path.concat([key])
      const args = [root, 'delete', localPath, o[key], undefined]

      updateBefore(...args)
      Reflect.deleteProperty(o, key)
      updateAfter(...args)
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
  const pathListeners = listenersForRoot.get(root)
  if (pathListeners.has(listenerPath)) {
    for (const listener of pathListeners.get(listenerPath)) {
      listener(newValue, oldValue, action, propertyPath, root)
    }
  }
}

const EACH = Symbol('objerve [each]')
const SORT = {
  TRUNK_FIRST: Symbol('sort order: trunk → leaf'),
  LEAF_FIRST: Symbol('sort order: leaf → trunk'),
}
const getAllMatchingPaths = (obj, akmap, pathPrefix, sortOrder) => {
  // Get all paths in the object that the given array-keyed-map also has paths
  // for.  The akmap is passed so that we can prune the search, and avoid
  // listing path branches we don't even have a subscriber for.
  //
  // For aliases like the EACH symbol, it is necessary to return 2 paths: the
  // path that the listener is at (containing e.g. EACH), and the actual
  // property path.  Hence the values in the array being objects.

  let paths = []

  // Transform the path looking for array indexes and turning them into EACH
  // symbols.  That way we can check for listeners to those too.
  const pathPrefixGeneralised = (() => {
    let gotSomething = false
    const generalised = []
    for (const prop of pathPrefix) {
      if (isArrayIndex(prop)) {
        gotSomething = true
        generalised.push(EACH)
      } else {
        generalised.push(prop)
      }
    }
    if (gotSomething) return generalised
  })()

  if (akmap.hasPrefix(pathPrefix)
      || (pathPrefixGeneralised && akmap.hasPrefix(pathPrefixGeneralised))) {
    // Explore further

    const visitTrunk = () => {
      // Do we have it?
      if (pathPrefixGeneralised && akmap.has(pathPrefixGeneralised)) {
        paths.push({
          propertyPath: pathPrefix,
          listenerPath: pathPrefixGeneralised,
        })
      }
      if (akmap.has(pathPrefix)) {
        paths.push({
          propertyPath: pathPrefix,
          listenerPath: pathPrefix,
        })
      }
    }

    const visitLeaves = () => {
      // Do branches have it?
      if (isObjectOrArray(obj)) {
        for (const key of Object.keys(obj)) {
          paths = paths.concat(
            getAllMatchingPaths(
              obj[key], akmap, pathPrefix.concat([key]), sortOrder))
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

  }
  return paths
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

const updateBefore = (root, action, path, oldValue, newValue) => {

  const oldIsPrimitive = !isObjectOrArray(oldValue)
  const newIsPrimitive = !isObjectOrArray(newValue)

  debug({root, action, path, oldValue, newValue})

  if (oldIsPrimitive && newIsPrimitive) {
    debug([ path, oldValue, "primitive -> primitive", newValue])
    // Both primitives.  Just call the listener for this path.
    const pathListeners = listenersForRoot.get(root)

    const whereIsIt = getAllMatchingPaths(
      newValue, pathListeners, path, SORT.TRUNK_FIRST)
    for (const {listenerPath, propertyPath} of whereIsIt) {
      const pathRelative = propertyPath.slice(path.length)
      callListeners(root, action, listenerPath, propertyPath,
        getPath(root, propertyPath),
        getPath(newValue, pathRelative))
    }

  } else if (oldIsPrimitive && !newIsPrimitive) {
    debug([ path, oldValue, "primitive -> object", newValue])
    // Primitive being overwritten with an Object.  Call listeners for every
    // relevant path in the new object.
    const pathListeners = listenersForRoot.get(root)

    const whereIsIt = getAllMatchingPaths(
      newValue, pathListeners, path, SORT.TRUNK_FIRST)
    for (const {listenerPath, propertyPath} of whereIsIt) {
      const pathRelative = propertyPath.slice(path.length)
      callListeners(root, 'create', listenerPath, propertyPath,
        getPath(root, propertyPath),
        getPath(newValue, pathRelative))
    }

  } else if (!oldIsPrimitive && newIsPrimitive) {
    debug([ path, oldValue, "object -> primitive", newValue])
    // Object being overwritten with a primitive value.  Call listeners for
    // every relevant path in the old object.
    const pathListeners = listenersForRoot.get(root)

    const whereIsIt = getAllMatchingPaths(
      oldValue, pathListeners, path, SORT.LEAF_FIRST)
    for (const {listenerPath, propertyPath} of whereIsIt) {
      callListeners(root, 'delete', listenerPath, propertyPath,
        getPath(root, propertyPath),
        undefined)
    }

  } else {
    debug([ path, oldValue, "object -> object", newValue])
    // Both Objects.  Diff them and call listeners for all the relevant paths.
    const {added, updated, deleted} = diffObjects(oldValue, newValue)
    const pathListeners = listenersForRoot.get(root)

    // Handle added
    ;(() => {
      const whereIsIt = getAllMatchingPaths(
        added, pathListeners, path, SORT.TRUNK_FIRST)
      for (const {listenerPath, propertyPath} of whereIsIt) {
        const pathRelative = propertyPath.slice(path.length)
        if (pathRelative.length === 0) continue
        callListeners(root, 'create', listenerPath, propertyPath,
          getPath(root, propertyPath),
          getPath(added, pathRelative))
      }
    })()

    // Handle updated
    ;(() => {
      const whereIsIt = getAllMatchingPaths(
        updated, pathListeners, path, SORT.TRUNK_FIRST)
      for (const {listenerPath, propertyPath} of whereIsIt) {
        const pathRelative = propertyPath.slice(path.length)
        if (pathRelative.length === 0) continue
        callListeners(root, 'change', listenerPath, propertyPath,
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

    // In case there is a listener specifically for this path that now
    // contains an object that is being reassigned, let's call that too.
    callListeners(root, 'change', path, path, oldValue, newValue)
  }
}
const updateAfter = (root, action, path, oldValue, newValue) => {
  // TODO
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
