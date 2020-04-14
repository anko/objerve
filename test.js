const objerve = require('./' + require('./package.json').main)
const test = require('tape')

const callLog = (userF) => {
  const calls = []
  const f = function () {
    calls.push(Array.from(arguments))
    if (userF) { userF(...arguments) }
  }
  return { f, calls }
}

const callArgsEqual = (t, calls, expected) => {
  // Check without ID arguments
  const callsWithoutId = calls.map((args) => args.slice(0, 4))
  const expectedWithoutId = expected.map((args) => args.slice(0, 4))
  t.deepEqual(callsWithoutId, expectedWithoutId)

  // If there are ID arguments, check that they match
  const callIds = calls.map((args) => args[5])
  const expectedIdArrays = expected.map((args) => args[5])

  //console.log(callIds, expectedIdArrays)

  for (let [i, expectedIdArray] of expectedIdArrays.entries()) {
    if (expectedIdArray === undefined) continue
    expectedIdArray.push(callIds[i])
  }
}
const allEqual = (array) => {
  if (array.length === 0) return true
  let firstValue = array[0]
  let stillEqual = true
  for (let v of array) {
    if (v !== firstValue) stillEqual = false
  }
  return stillEqual
}

test('assigned primitive', (t) => {
  const obj = objerve({})

  const {calls: calls_a, f: f_a} = callLog()
  objerve.addListener(obj, ['a'], f_a)

  const {calls: calls_empty, f: f_empty} = callLog()
  objerve.addListener(obj, [], f_empty)

  obj.a = 3

  callArgsEqual(t, calls_a, [
    [3, undefined, 'create', ['a'], obj],
  ])
  callArgsEqual(t, calls_empty, [])
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

  callArgsEqual(t, calls_a, [
    [{b: 1}, undefined, 'create', ['a'], obj],
    [{c: {test: 'ok'}}, {b: 1}, 'change', ['a'], obj],
    [undefined, {c: {test: 'ok'}}, 'delete', ['a'], obj],
  ])
  t.end()
})

test('object assigned 1 level up', (t) => {
  const obj = objerve({})

  const {calls: calls_ab, f: f_ab} = callLog()
  objerve.addListener(obj, ['a', 'b'], f_ab)

  obj.a = {b: 1}
  obj.a = {b: 2}

  callArgsEqual(t, calls_ab, [
    [1, undefined, 'create', ['a', 'b'], obj],
    [2, 1, 'change', ['a', 'b'], obj],
  ])
  t.end()
})

test('object assigned 2 levels up', (t) => {
  const obj = objerve()

  const {calls, f} = callLog()
  objerve.addListener(obj, ['a', 'b', 'c'], f)

  obj.a = {b: {c: 1}}

  callArgsEqual(t, calls, [
    [1, undefined, 'create', ['a', 'b', 'c'], obj],
  ])
  t.end()
})

test('object deleted from under us', (t) => {
  const obj = objerve()

  const {calls, f} = callLog()
  objerve.addListener(obj, ['a', 'b', 'c'], f)

  obj.a = {b: {c: 1}}

  obj.a.b = null

  callArgsEqual(t, calls, [
    [1, undefined, 'create', ['a', 'b', 'c'], obj],
    [undefined, 1, 'delete', ['a', 'b', 'c'], obj],
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

  callArgsEqual(t, calls_aa, [
    [true, undefined, 'create', ['a', 'a'], obj],
  ])

  callArgsEqual(t, calls_ab, [
    [true, undefined, 'create', ['a', 'b'], obj],
    ['something else', true, 'change', ['a', 'b'], obj],
  ])

  callArgsEqual(t, calls_ac, [
    [true, undefined, 'create', ['a', 'c'], obj],
    [undefined, true, 'delete', ['a', 'c'], obj],
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
  callArgsEqual(t, calls, [
    [{b: false}, undefined, 'create', ['a'], obj],
    [true, undefined, 'create', ['a', 'b'], obj],
    [false, true, 'change', ['a', 'b'], obj],
    [undefined, false, 'delete', ['a', 'b'], obj],
    [undefined, {b: false}, 'delete', ['a'], obj],
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
  callArgsEqual(t, calls, [
    [{c: true}, undefined, 'create', ['a', 'b'], obj],
    [true, undefined, 'create', ['a', 'b', 'c'], obj],
    [{c: false}, {c: true}, 'change', ['a', 'b'], obj],
    [false, true, 'change', ['a', 'b', 'c'], obj],
    [undefined, false, 'delete', ['a', 'b', 'c'], obj],
    [undefined, {c: false}, 'delete', ['a', 'b'], obj],
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

  callArgsEqual(t, calls, [
    [1, undefined, 'create', ['a'], obj],
  ])
  t.end()
})

test('removeListener called from a listener for same path listener', (t) => {
  const obj = objerve({})

  const {calls, f} = callLog()

  // First add a listener that removes the other listener
  objerve.addListener(obj, ['a'], (newValue, oldValue, action, path, obj) => {
    objerve.removeListener(obj, path, f)
  })

  // Add the original listener after it
  objerve.addListener(obj, ['a'], f)

  obj.a = 1

  // It's gone before it's called!
  callArgsEqual(t, calls, [])
  t.end()
})

test('addListener called from a listener for same path', (t) => {
  const obj = objerve({})

  const {calls, f} = callLog()

  // Add a listener that adds the other listener to it
  objerve.addListener(obj, ['a'], (newValue, oldValue, action, path) => {
    objerve.addListener(obj, path, f)
  })

  obj.a = 1

  // It gets called!
  callArgsEqual(t, calls, [
    [1, undefined, 'create', ['a'], obj]
  ])
  t.end()
})

test('adding listener for same level relative path inside listener', (t) => {
  const obj = objerve({})

  const {calls: callsBefore, f: fBefore} = callLog()
  const {calls: callsAfter, f: fAfter} = callLog()

  const {calls, f} = callLog((newValue, oldValue, action, path) => {
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

  callArgsEqual(t, calls, [
    [2, undefined, 'create', ['a', 'main'], obj],
    [undefined, 2, 'delete', ['a', 'main'], obj],
  ])
  // For creation, the obj.a.before listener wasn't called, because it only
  // came into existence when obj.a = {...} fired obj.a.main's listener.  For
  // deletion, obj.a.before's listener had already been called by the time that
  // obj.a.main's listener removed it, because it's earlier in iteration order.
  callArgsEqual(t, callsBefore, [
    [undefined, 1, 'delete', ['a', 'before'], obj],
  ])
  // For creation, the obj.a.after listener wasn't called, because it only came
  // into existence when obj.a = {...} fired obj.a.main's listener.  For
  // deletion, obj.a.after's listener also wasn't called, because obj.a.main's
  // listener was called first, which removed it.
  callArgsEqual(t, callsAfter, [])
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
  callArgsEqual(t, calls, [
    [undefined, undefined, 'create', ['a'], obj],
    [undefined, undefined, 'change', ['a'], obj],
    [undefined, undefined, 'delete', ['a'], obj],
  ])
  t.end()
})

test('[each]', (t) => {
  const obj = objerve()

  const {calls, f} = callLog()

  // objerve.each matches any array index
  objerve.addListener(obj, ['a', objerve.each], f)

  obj.a = ['zero']
  obj.a = ['zero', 'one']
  obj.a = ['one']

  callArgsEqual(t, calls, [
    ['zero', undefined, 'create', ['a', 0], obj],
    ['one', undefined, 'create', ['a', 1], obj],
    ['one', 'zero', 'change', ['a', 0], obj],
    [undefined, 'one', 'delete', ['a', 1], obj],
  ])
  t.end()
})

test('[each] -> something else', (t) => {
  const obj = objerve()

  const {calls, f} = callLog()

  objerve.addListener(obj, ['a', objerve.each, 'x'], f)

  obj.a = [{x: 'hi'}]
  obj.a.push({x: 'hello'})

  callArgsEqual(t, calls, [
    ['hi', undefined, 'create', ['a', 0, 'x'], obj],
    ['hello', undefined, 'create', ['a', 1, 'x'], obj],
  ])
  t.end()
})

test('bare [each]', (t) => {
  const obj = objerve([])

  const {calls, f} = callLog()

  objerve.addListener(obj, [objerve.each], f)

  obj.push('hi')
  obj.push('hi')
  obj.length = 1 // Truncate off one of them

  callArgsEqual(t, calls, [
    ['hi', undefined, 'create', [0], obj],
    ['hi', undefined, 'create', [1], obj],
    [undefined, 'hi', 'delete', [1], obj],
  ])
  t.end()
})

test('[each] getting truncated respects nesting order', (t) => {
  const obj = objerve()

  const {calls, f} = callLog()

  objerve.addListener(obj, ['a', objerve.each], f)
  objerve.addListener(obj, ['a'], f)

  obj.a = []
  obj.a.push('hi')
  obj.a.push('hi')
  delete obj.a

  callArgsEqual(t, calls, [
    [['hi', 'hi'], undefined, 'create', ['a'], obj],
    ['hi', undefined, 'create', ['a', 0], obj],
    ['hi', undefined, 'create', ['a', 1], obj],
    [undefined, 'hi', 'delete', ['a', 0], obj],
    [undefined, 'hi', 'delete', ['a', 1], obj],
    [undefined, ['hi', 'hi'], 'delete', ['a'], obj],
  ])
  t.end()
})

test('listening for array length property', (t) => {
  const obj = objerve([])

  const {calls, f} = callLog()

  objerve.addListener(obj, ['length'], f)

  obj.push(true)
  obj.push(true)
  obj.length = 0
  obj.length = 3

  callArgsEqual(t, calls, [
    [1, 0, 'change', ['length'], obj],
    [2, 1, 'change', ['length'], obj],
    [0, 2, 'change', ['length'], obj],
    [3, 0, 'change', ['length'], obj],
  ])

  t.end()
})

test('multiple [each]es and indexes all get called', (t) => {
  const obj = objerve()

  const {calls: calls_e_e, f: f_e_e} = callLog()
  const {calls: calls_e_0, f: f_e_0} = callLog()

  objerve.addListener(obj, ['a', objerve.each, objerve.each], f_e_e)
  objerve.addListener(obj, ['a', objerve.each, 0], f_e_0)

  obj.a = [['x']]
  obj.a = [['x'], ['y']]
  delete obj.a

  // Both get called the same way
  callArgsEqual(t, calls_e_e, [
    ['x', undefined, 'create', ['a', 0, 0], obj],
    ['y', undefined, 'create', ['a', 1, 0], obj],
    [undefined, 'x', 'delete', ['a', 0, 0], obj],
    [undefined, 'y', 'delete', ['a', 1, 0], obj],
  ])
  callArgsEqual(t, calls_e_0, [
    ['x', undefined, 'create', ['a', 0, 0], obj],
    ['y', undefined, 'create', ['a', 1, 0], obj],
    [undefined, 'x', 'delete', ['a', 0, 0], obj],
    [undefined, 'y', 'delete', ['a', 1, 0], obj],
  ])

  t.end()
})

test('prefix listener', (t) => {
  const obj = objerve()

  const {calls, f} = callLog()

  objerve.addPrefixListener(obj, [], f)

  obj.a = 1
  obj.b = 2
  obj.a = {c: 3}

  obj.a = {x: {y: {z: 42}}}
  obj.a.x.y.z = 69
  delete obj.a

  callArgsEqual(t, calls, [
    [1, undefined, 'create', ['a'], obj],
    [2, undefined, 'create', ['b'], obj],
    [{c: 3}, 1, 'change', ['a'], obj],
    [3, undefined, 'create', ['a', 'c'], obj],

    [{x:{y:{z:69}}}, {c:3}, 'change', ['a'], obj],
    [{y:{z:69}}, undefined, 'create', ['a', 'x'], obj],
    [{z:69}, undefined, 'create', ['a', 'x', 'y'], obj],
    [42, undefined, 'create', ['a', 'x', 'y', 'z'], obj],
    [undefined, 3, 'delete', ['a', 'c'], obj],
    [69, 42, 'change', ['a', 'x', 'y', 'z'], obj],
    [undefined, 69, 'delete', ['a', 'x', 'y', 'z'], obj],
    [undefined, {z:69}, 'delete', ['a', 'x', 'y'], obj],
    [undefined, {y:{z:69}}, 'delete', ['a', 'x'], obj],
    [undefined, {x:{y:{z:69}}}, 'delete', ['a'], obj],
  ])

  t.end()
})

test('removePrefixListener', (t) => {
  const obj = objerve()
  const {calls, f} = callLog()
  objerve.addPrefixListener(obj, [], f)

  obj.x = 'x'
  objerve.removePrefixListener(obj, [], f)
  obj.x = 'y'

  callArgsEqual(t, calls, [
    ['x', undefined, 'create', ['x'], obj],
  ])
  t.end()
})

test('generic listener call order respects nesting', (t) => {
  const obj = objerve([])
  const which = []
  objerve.addPrefixListener(obj, [], () => which.push('prefix'))
  objerve.addListener(obj, [objerve.each], () => which.push('each'))
  objerve.addListener(obj, [0], () => which.push('index'))

  obj[0] = 'x'
  obj[0] = 'y'
  delete obj[0]

  t.deepEquals(which, [
    'prefix', 'each', 'index',
    'prefix', 'each', 'index',
    'index', 'each', 'prefix'
  ])
  t.end()
})

test('objerve instance as property of another', (t) => {
  const obj1 = objerve()
  const obj2 = objerve()

  const {calls: calls1, f: f1} = callLog()
  const {calls: calls2, f: f2} = callLog()

  objerve.addListener(obj1, ['a', 'b'], f1)
  objerve.addListener(obj2, ['b'], f2)

  obj2.b = true
  obj1.a = obj2
  delete obj2.b

  // Setting obj1.a to something that isn't obj2 should break the link between
  // the two, so obj1 listeners no longer get updates for obj2.b changing.
  obj1.a = {}
  obj1.a.b = 'test 1'
  obj2.b = 'test 2'

  callArgsEqual(t, calls1, [
    [true, undefined, 'create', ['a', 'b'], obj1],
    [undefined, true, 'delete', ['a', 'b'], obj1],
    ["test 1", undefined, 'create', ['a', 'b'], obj1],
  ])

  callArgsEqual(t, calls2, [
    [true, undefined, 'create', ['b'], obj2],
    [undefined, true, 'delete', ['b'], obj2],
    ['test 2', undefined, 'create', ['b'], obj2],
  ])
  t.end()
})

test('objerve instance property passed as property', (t) => {
  const obj1 = objerve()
  const obj2 = objerve()

  const {calls: calls1, f: f1} = callLog()
  const {calls: calls2, f: f2} = callLog()

  objerve.addListener(obj1, ['a', 'b'], f1)
  objerve.addListener(obj2, ['x', 'b'], f2)

  obj2.x = {b: true}
  obj1.a = obj2.x

  delete obj2.x.b

  callArgsEqual(t, calls1, [
    [true, undefined, 'create', ['a', 'b'], obj1],
    [undefined, true, 'delete', ['a', 'b'], obj1],
  ])

  callArgsEqual(t, calls2, [
    [true, undefined, 'create', ['x', 'b'], obj2],
    [undefined, true, 'delete', ['x', 'b'], obj2],
  ])
  t.end()
})

test('addListener to subproperty', (t) => {
  const obj = objerve()
  const {calls, f} = callLog()
  obj.a = {b: true}
  objerve.addListener(obj.a, ['b'], f)
  obj.a.b = false

  callArgsEqual(t, calls, [
    [false, true, 'change', ['b'], obj.a],
  ])
  t.end()
})

test('circular reference', (t) => {
  const obj = objerve()
  const {calls, f} = callLog()
  obj.a = obj
  objerve.addListener(obj.a.a.a.a.a.a.a.a.a, ['a'], f)
  obj.a = obj

  callArgsEqual(t, calls, [
    [obj, obj, 'change', ['a'], obj],
  ])
  t.end()
})

test('circular reference over 2 objerve instances', (t) => {
  const obj1 = objerve()
  const obj2 = objerve()
  const {calls, f} = callLog()
  obj1.a = obj2
  objerve.addListener(obj1.a, ['b'], f)
  obj2.b = obj1

  callArgsEqual(t, calls, [
    [obj1, undefined, 'create', ['b'], obj2],
  ])
  t.end()
})

test('circular reference over 3 objerve instances', (t) => {
  const obj1 = objerve()
  const obj2 = objerve()
  const obj3 = objerve()
  const {calls, f} = callLog()
  obj1.a = obj2
  obj2.b = obj3
  objerve.addListener(obj3, ['c', 'a', 'b'], f)
  obj3.c = obj1

  callArgsEqual(t, calls, [
    [obj3, undefined, 'create', ['c', 'a', 'b'], obj3],
  ])
  t.end()
})

test('updates caused by assignment in listener get same update id', (t) => {
  const obj = objerve()
  const {calls: calls1, f: f1} = callLog((newValue) => {
    if (newValue > 0) {
      obj.b = newValue - 1
    }
  })
  const {calls: calls2, f: f2} = callLog((newValue) => {
    if (newValue > 0) {
      obj.a = newValue - 1
    }
  })
  objerve.addListener(obj, ['a'], f1)
  objerve.addListener(obj, ['b'], f2)

  obj.a = 3
  t.equals(obj.a, 1)
  t.equals(obj.b, 0)

  const shouldBeSame1 = []
  const shouldBeSame2 = []
  callArgsEqual(t, calls1, [
    [3, undefined, 'create', ['a'], obj, shouldBeSame1],
    [1, undefined, 'create', ['a'], obj, shouldBeSame1],
  ])
  callArgsEqual(t, calls2, [
    [2, undefined, 'create', ['b'], obj, shouldBeSame1],
    [0, undefined, 'create', ['b'], obj, shouldBeSame1],
  ])
  t.ok(allEqual(shouldBeSame1),
    `same update id ${JSON.stringify(shouldBeSame1)}`)

  obj.a = 3
  t.equals(obj.a, 1)
  t.equals(obj.b, 0)

  callArgsEqual(t, calls1, [
    [3, undefined, 'create', ['a'], obj, shouldBeSame1],
    [1, undefined, 'create', ['a'], obj, shouldBeSame1],
    [3, 1, 'change', ['a'], obj, shouldBeSame2],
    [1, 1, 'change', ['a'], obj, shouldBeSame2],
  ])
  callArgsEqual(t, calls2, [
    [2, undefined, 'create', ['b'], obj, shouldBeSame1],
    [0, undefined, 'create', ['b'], obj, shouldBeSame1],
    [2, 0, 'change', ['b'], obj, shouldBeSame2],
    [0, 0, 'change', ['b'], obj, shouldBeSame2],
  ])
  t.ok(allEqual(shouldBeSame1),
    `same update id ${JSON.stringify(shouldBeSame1)}`)
  t.ok(allEqual(shouldBeSame2),
    `same update id ${JSON.stringify(shouldBeSame2)}`)

  t.end()
})
