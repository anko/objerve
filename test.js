const objerve = require('./' + require('./package.json').main)
const test = require('tape')

const callLog = (userF) => {
  const calls = []
  const f = function () {
    if (userF) { userF(...arguments) }
    calls.push(Array.from(arguments))
  }
  return { f, calls }
}

test('assigned primitive', (t) => {
  const obj = objerve({})

  const {calls: calls_a, f: f_a} = callLog()
  objerve.addListener(obj, ['a'], f_a)

  const {calls: calls_empty, f: f_empty} = callLog()
  objerve.addListener(obj, [], f_empty)

  obj.a = 3

  t.deepEqual(calls_a, [
    ['create', ['a'], 3, undefined],
  ])
  t.deepEqual(calls_empty, [])
  t.end()
})

test('assigned object', (t) => {
  const obj = objerve({})

  const {calls: calls_a, f: f_a} = callLog()
  objerve.addListener(obj, ['a'], f_a)

  // This fires 'create'
  obj.a = {b: 1}
  // This fires 'change'
  obj.a = {c: 1}
  // These don't fire anything (just change state)
  obj.a.c = {test: "hi"}
  obj.a.c.test = 'ok'
  // This fires 'delete'
  delete obj.a

  t.deepEqual(calls_a, [
    ['create', ['a'], {b: 1}, undefined],
    ['change', ['a'], {c: {test: 'ok'}}, {b: 1}],
    ['delete', ['a'], undefined, {c: {test: 'ok'}}],
  ])
  t.end()
})

test('object assigned 1 level up', (t) => {
  const obj = objerve({})

  const {calls: calls_ab, f: f_ab} = callLog()
  objerve.addListener(obj, ['a', 'b'], f_ab)

  obj.a = {b: 1}

  t.deepEqual(calls_ab, [
    ['create', ['a', 'b'], 1, undefined],
  ])
  t.end()
})

test('object assigned 2 levels up', (t) => {
  const x = objerve()

  const {calls, f} = callLog()
  objerve.addListener(x, ['a', 'b', 'c'], f)

  x.a = {b: {c: 1}}

  t.deepEqual(calls, [
    ['create', ['a', 'b', 'c'], 1, undefined],
  ])
  t.end()
})

test('object deleted from under us', (t) => {
  const x = objerve()

  const {calls, f} = callLog()
  objerve.addListener(x, ['a', 'b', 'c'], f)

  x.a = {b: {c: 1}}

  x.a.b = null

  t.deepEqual(calls, [
    ['create', ['a', 'b', 'c'], 1, undefined],
    ['delete', ['a', 'b', 'c'], undefined, 1],
  ])
  t.end()
})


test('still object, but properties reassigned', (t) => {
  const obj = objerve({})

  const {calls: calls_aa, f: f_aa} = callLog()
  objerve.addListener(obj, ['a', 'a'], f_aa)

  const {calls: calls_ab, f: f_ab} = callLog()
  objerve.addListener(obj, ['a', 'b'], f_ab)

  const {calls: calls_ac, f: f_ac} = callLog()
  objerve.addListener(obj, ['a', 'c'], f_ac)

  // Initially, set b and c
  obj.a = {b: true, c: true}

  // Reassign the whole object from under them
  // Create a
  obj.a = {
    // create a
    a: true,

    // change b
    b: 'something else',

    // delete c
  }

  t.deepEqual(calls_aa, [
    ['create', ['a', 'a'], true, undefined],
  ])

  t.deepEqual(calls_ab, [
    ['create', ['a', 'b'], true, undefined],
    ['change', ['a', 'b'], 'something else', true],
  ])

  t.deepEqual(calls_ac, [
    ['create', ['a', 'c'], true, undefined],
    ['delete', ['a', 'c'], undefined, true],
  ])
  t.end()
})

test('trunk and leaf call order', (t) => {
  const obj = objerve({})

  const {calls, f} = callLog()
  objerve.addListener(obj, ['a'], f)
  objerve.addListener(obj, ['a', 'b'], f)

  obj.a = {b: true}
  obj.a.b = false
  delete obj.a

  // For additions, trunk is called before leaf.
  // For deletions, leaf is called before trunk.
  t.deepEqual(calls, [
    ['create', ['a'], {b: false}, undefined],
    ['create', ['a', 'b'], true, undefined],
    ['change', ['a', 'b'], false, true],
    ['delete', ['a', 'b'], undefined, false],
    ['delete', ['a'], undefined, {b: false}],
  ])
  t.end()
})

test('trunk and leaf call order when object-diffed', (t) => {
  const obj = objerve({})

  const {calls, f} = callLog()
  objerve.addListener(obj, ['a', 'b'], f)
  objerve.addListener(obj, ['a', 'b', 'c'], f)

  obj.a = {b: {c: true}}
  obj.a = {b: {c: false}}
  obj.a = {}

  // For additions, trunk is called before leaf.
  // For deletions, leaf is called before trunk.
  t.deepEqual(calls, [
    ['create', ['a', 'b'], {c: true}, undefined],
    ['create', ['a', 'b', 'c'], true, undefined],
    ['change', ['a', 'b'], {c: false}, {c: true}],
    ['change', ['a', 'b', 'c'], false, true],
    ['delete', ['a', 'b', 'c'], undefined, false],
    ['delete', ['a', 'b'], undefined, {c: false}],
  ])
  t.end()
})

test('removeListener', (t) => {
  const obj = objerve({})

  const {calls, f} = callLog()
  objerve.addListener(obj, ['a'], f)

  obj.a = 1
  objerve.removeListener(obj, ['a'], f)
  delete obj.a

  t.deepEqual(calls, [
    ['create', ['a'], 1, undefined],
  ])
  t.end()
})

test('removeListener called from a listener for same path listener', (t) => {
  const obj = objerve({})

  const {calls, f} = callLog()

  // First add a listener that removes the other listener
  objerve.addListener(obj, ['a'], (action, path) => {
    objerve.removeListener(obj, path, f)
  })

  // Add the original listener after it
  objerve.addListener(obj, ['a'], f)

  obj.a = 1

  // It's gone before it's called!
  t.deepEqual(calls, [])
  t.end()
})

test('addListener called from a listener for same path', (t) => {
  const obj = objerve({})

  const {calls, f} = callLog()

  // Add a listener that adds the other listener to it
  objerve.addListener(obj, ['a'], (action, path) => {
    objerve.addListener(obj, path, f)
  })

  obj.a = 1

  // It gets called!
  t.deepEqual(calls, [
    ['create', ['a'], 1, undefined]
  ])
  t.end()
})

test('adding listener for same level relative path inside listener', (t) => {
  const obj = objerve({})

  const {calls: callsBefore, f: fBefore} = callLog()
  const {calls: callsAfter, f: fAfter} = callLog()

  const {calls, f} = callLog((action, path) => {
    if (action === 'delete') {
      objerve.removeListener(
        obj,
        path.slice(0, -1).concat(['before']), // [parent].before,
        fBefore)
      objerve.removeListener(
        obj,
        path.slice(0, -1).concat(['after']), // [parent].after,
        fAfter)
    } else {
      objerve.addListener(
        obj,
        path.slice(0, -1).concat(['before']), // [parent].before,
        fBefore)
      objerve.addListener(
        obj,
        path.slice(0, -1).concat(['after']), // [parent].after,
        fAfter)
    }
  })

  objerve.addListener(obj, ['a', 'main'], f)

  obj.a = {before: 1, main: 2, after: 3}
  delete obj.a

  t.deepEqual(calls, [
    ['create', ['a', 'main'], 2, undefined],
    ['delete', ['a', 'main'], undefined, 2],
  ])
  // For creation, the obj.a.before listener wasn't called, because it only
  // came into existence when obj.a = {...} fired obj.a.main's listener.  For
  // deletion, obj.a.before's listener had already been called by the time that
  // obj.a.main's listener removed it, because it's earlier in iteration order.
  t.deepEqual(callsBefore, [
    ['delete', ['a', 'before'], undefined, 1],
  ])
  // For creation, the obj.a.after listener wasn't called, because it only came
  // into existence when obj.a = {...} fired obj.a.main's listener.  For
  // deletion, obj.a.after's listener also wasn't called, because obj.a.main's
  // listener was called first, which removed it.
  t.deepEqual(callsAfter, [])
  t.end()
})

test('property with undefined as value', (t) => {
  const obj = objerve({})

  const {calls, f} = callLog()

  // Add a listener that adds the other listener to it
  objerve.addListener(obj, ['a'], f)

  obj.a = undefined
  obj.a = undefined
  delete obj.a

  // The action argument can be used to distinguish between 'undefined' being
  // assigned as a value and just being there because the property was deleted.
  t.deepEqual(calls, [
    ['create', ['a'], undefined, undefined],
    ['change', ['a'], undefined, undefined],
    ['delete', ['a'], undefined, undefined],
  ])
  t.end()
})
