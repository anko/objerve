const akm = require('array-keyed-map')
const deepObjectDiff = require('deep-object-diff').detailedDiff

const debug = () => {}
debug['active'] = console.log

const proxy = (template, rootArg, path=[]) => {
  // Primitive values can't have properties, so need no wrapper.
  if (!isObjectOrArray(template)) return template

  // Everything beyond this point handles proxying Objects that have
  // properties.

  // Make a local copy we can modify without messing up existing references.
  const obj = Object.assign({}, template)

  let root

  const node = new Proxy(obj, {
    set: (_, key, value) => {
      let localPath = path.concat([key])
      value = proxy(value, root, localPath)
      let actionName = key in obj ? 'change' : 'create'
      const args = [root, actionName, localPath, obj[key], value]

      updateBefore(...args)
      obj[key] = value
      updateAfter(...args)
    },
    deleteProperty: (_, key) => {
      let localPath = path.concat([key])
      const args = [root, 'delete', localPath, obj[key], undefined]

      updateBefore(...args)
      delete obj[key]
      updateAfter(...args)
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

const callListeners = (root, action, path, oldValue, newValue) => {
  debug({root, action, path, oldValue, newValue})
  const listeners = listenersForRoot.get(root)
  if (listeners.has(path)) {
    for (const listener of listeners.get(path)) {
      listener(action, path, newValue, oldValue)
    }
  }
}

const SORT = {
  TRUNK_FIRST: Symbol('sort order: trunk → leaf'),
  LEAF_FIRST: Symbol('sort order: leaf → trunk'),
}
const getAllMatchingPaths = (obj, akmap, pathPrefix, sortOrder) => {
  // Get all paths in the object that the given array-keyed-map also has paths
  // for.  The akmap is passed so that we can prune the search, and avoid
  // listing path branches we don't even have a subscriber for.
  //
  // Returns an array of paths.

  let paths = []

  if (akmap.hasPrefix(pathPrefix)) {
    // Explore further

    const visitTrunk = () => {
      // Do we have it?
      if (akmap.has(pathPrefix)) {
        paths.push(pathPrefix)
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
    callListeners(root, action, path, oldValue, newValue)

  } else if (oldIsPrimitive && !newIsPrimitive) {
    debug([ path, oldValue, "primitive -> object", newValue])
    // Primitive being overwritten with an Object.  Call listeners for every
    // relevant path in the new object.
    const pathListeners = listenersForRoot.get(root)

    const absolutePaths = getAllMatchingPaths(
      newValue, pathListeners, path, SORT.TRUNK_FIRST)
    for (const absolutePath of absolutePaths) {
      const pathRelative = absolutePath.slice(path.length)
      callListeners(root, 'create', absolutePath,
        getPath(root, absolutePath),
        getPath(newValue, pathRelative))
    }

  } else if (!oldIsPrimitive && newIsPrimitive) {
    debug([ path, oldValue, "object -> primitive", newValue])
    // Object being overwritten with a primitive value.  Call listenrs for
    // every relevant path in the old object.
    const pathListeners = listenersForRoot.get(root)

    const absolutePaths = getAllMatchingPaths(
      oldValue, pathListeners, path, SORT.LEAF_FIRST)
    for (const absolutePath of absolutePaths) {
      callListeners(root, 'delete', absolutePath,
        getPath(root, absolutePath),
        undefined)
    }

  } else {
    debug([ path, oldValue, "object -> object", newValue])
    // Both Objects.  Diff them and call listeners for all the relevant paths.
    const {added, updated, deleted} = diffObjects(oldValue, newValue)
    const pathListeners = listenersForRoot.get(root)

    // Handle added
    ;(() => {
      const absolutePaths = getAllMatchingPaths(
        added, pathListeners, path, SORT.TRUNK_FIRST)
      for (const absolutePath of absolutePaths) {
        const pathRelative = absolutePath.slice(path.length)
        if (pathRelative.length === 0) continue
        callListeners(root, 'create', absolutePath,
          getPath(root, absolutePath),
          getPath(added, pathRelative))
      }
    })()

    // Handle updated
    ;(() => {
      const absolutePaths = getAllMatchingPaths(
        updated, pathListeners, path, SORT.TRUNK_FIRST)
      for (const absolutePath of absolutePaths) {
        const pathRelative = absolutePath.slice(path.length)
        if (pathRelative.length === 0) continue
        callListeners(root, 'change', absolutePath,
          getPath(root, absolutePath),
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
        const absolutePaths = getAllMatchingPaths(
          getPath(root, path.concat([deletedProp])),
          pathListeners,
          path.concat([deletedProp]),
          SORT.LEAF_FIRST)
        for (const absolutePath of absolutePaths) {
          const pathRelative = absolutePath.slice(path.length)
          if (pathRelative.length === 0) continue
          callListeners(root, 'delete', absolutePath,
            getPath(root, absolutePath),
            undefined)
      }

      }
    })()


    // In case there is a listener specifically for this path that now
    // contains an object that is being reassigned, let's call that too.
    callListeners(root, 'change', path, oldValue, newValue)
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

module.exports = proxyBase
proxyBase.addListener = addListener
proxyBase.removeListener = removeListener
