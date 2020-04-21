# objerve [![](https://img.shields.io/npm/v/objerve.svg?style=flat-square)](https://www.npmjs.com/package/objerve) [![](https://img.shields.io/travis/anko/objerve.svg?style=flat-square)](https://travis-ci.org/anko/objerve) [![](https://img.shields.io/coveralls/github/anko/objerve?style=flat-square)](https://coveralls.io/github/anko/objerve) [![](https://img.shields.io/david/anko/objerve?style=flat-square)](https://david-dm.org/anko/objerve)

Define callbacks that get fired when given object properties change.

![picture](https://user-images.githubusercontent.com/5231746/79608887-06a4df80-80f6-11ea-9476-b1e87e9efc38.png)

## example

<!-- !test program node -->

<!-- !test in first example -->
```js
const objerve = require('./main.js')

const obj = objerve()

objerve.addListener(obj, ['a', 'b'], (newValue, oldValue, action, path, obj) => {
  console.log(`${action} ${path.join('.')}: `+
    `${JSON.stringify(oldValue)} -> ${JSON.stringify(newValue)}`)
})

obj.a = { b: 'hi' }
obj.a.b = 'hello'
obj.a = null
```

<!-- !test out first example -->

> ```
> create a.b: undefined -> "hi"
> change a.b: "hi" -> "hello"
> delete a.b: "hello" -> undefined
> ```

## features

 - Behaves exactly like an ordinary Object
 - Can listen to fixed paths or to all paths with a prefix, and use
   [`objerve.each`](#objerveeach) inside paths to match all array indexes.
 - Putting objerve instances (or parts of them) inside each others' properties
   fully works, and property changes are propagated between instances as you'd
   expect if they are properties of each other (even with circular references)
 - Can tell apart `undefined` property value and property deletion, thanks to
   the `action` argument passed to callbacks (shows `created` / `changed` /
   `deleted`).
 - Calls your callbacks in [a nesting-respecting order](#call-order), so your
   callbacks can setup and teardown state in the correct order (bottom-up
   construction, top-down destruction)
 - Stores listeners in a prefix tree by target path, to speed up queries with
   large objects and many listeners.

## api

### `objerve([obj])`

Wrap the given object (default `{}`) so it can be subscribed to.

The resulting object behaves like the object did before, but changes to its
paths can be listened to with `objerve.addListener` or
`objerve.addPrefixListener`.

### `objerve.addListener(obj, path, callback)`

The path can contain `objerve.each`, which will match any Array index at that
position.

Works inside listener callbacks.  If inside a listener you add a new listener
that matches the same path, the new listener will also be called with this same
change.

### `objerve.removeListener(obj, path, callback)`

Remove the listener from the given path, so the callback is no longer called.
The path is useful to disambiguate in case the same callback function is being
used as the listener for multiple paths.

Does nothing if it cannot find such a listener.

Works inside listener callbacks.  If you remove a listener for the same path
inside a callback for that path, the removed listener won't be called for that
change either (unless it was already called before this one).

### `objerve.addPrefixListener(obj, path, callback)`

Same as `addListener`, but will be called for any property at all that has the
given `path` as a prefix.  Pass `[]` for the path to be called for every change
to any property.

### `objerve.removePrefixListener(obj, path, callback)`

Same as `removeListener`, but for prefix listeners.

### `objerve.each`

A special Symbol value that can be passed as part of a path to listen to.  It
matches any valid array index, i.e. `0`, `1`, `999999999` etc, so your listener
is called for every element of an array being created, changed, or deleted.

## how callbacks are called

Your callback function is called immediately before the described change is
actually applied to the object, with these arguments:

 - `newValue`
 - `oldValue`
 - `action`: One of the following strings:
   - `'create'` if the property did not exist, and is being created
   - `'change'` if the property exists, and its value is changing
   - `'delete'` if the property exists, but it is being deleted

   <p></p><details><summary>Example:  Using the <code>action></code> argument to distinguish property deletion from being set to <code>undefined</code></summary>

   <!-- !test in using change argument -->

   ```js
   const objerve = require('./main.js')
   const obj = objerve()

   objerve.addListener(obj, ['x'], (newValue, oldValue, action) => {
     console.log(`${action} ${oldValue} -> ${newValue}`)
   })

   obj.x = true
   obj.x = undefined
   delete obj.x
   ```

   <!-- !test out using change argument -->

   > ```
   > create undefined -> true
   > change true -> undefined
   > delete undefined -> undefined
   > ```

   Note how although both the `obj.x = undefined` and `delete obj.x` lines
   triggered a callback with `newValue` `undefined`, their `action`s differed:
   `'change'` and `'delete'`.

   </details>

 - `path`: An Array representing the property path through the object at which
   this update happened.  Useful if you have a single callback function
   listening to multiple paths.
 - `obj`: A reference to the object as it currently exists (just before the
   described update is actually applied).
 - `updateId`: A number uniquely identifying the currently happening change.
   All listeners that get called due to the same change (or caused by a
   callback reacting to the same change) see the same identifier.

   <details><summary>Example: same update id when a listener itself triggers a change</summary>

   <!-- !test in re-call -->
   ```js
   const objerve = require('./main.js')
   const obj = objerve()

   // Listen to changes to 'obj.a'.  Reduce it by 1 unless it's 0.
   objerve.addListener(obj, ['a'],
     (val, previousVal, action, path, objRef, updateId) => {
       console.log(`[${action}] ${previousVal} -> ${val} (updateId ${updateId})`)
       if (val > 0) {
         obj.a = val - 1
       }
     })
   // Also create a listener listening to all properties on 'obj'.
   objerve.addPrefixListener(obj, [],
     (val, previousVal, action, path, objRef, updateId) => {
       console.log(`prefix listener called (updateId ${updateId})`)
     })

   obj.a = 3
   console.log(obj.a)
   obj.a = 2
   console.log(obj.a)
   ```

   Each time something is assigned to `obj.a`, the first listener gets called,
   and assigns it 1 lower, until it's 0:

   <!-- !test out re-call -->

   > ```
   > prefix listener called (updateId 0)
   > [create] undefined -> 3 (updateId 0)
   > prefix listener called (updateId 0)
   > [create] undefined -> 2 (updateId 0)
   > prefix listener called (updateId 0)
   > [create] undefined -> 1 (updateId 0)
   > prefix listener called (updateId 0)
   > [create] undefined -> 0 (updateId 0)
   > 0
   > prefix listener called (updateId 1)
   > [change] 0 -> 2 (updateId 1)
   > prefix listener called (updateId 1)
   > [change] 0 -> 1 (updateId 1)
   > prefix listener called (updateId 1)
   > [change] 0 -> 0 (updateId 1)
   > 0
   > ```

   Note that for each individual change (`obj.a = 3` and `obj.a = 2`), both
   listeners were called multiple times, but during each change both were
   called with the same `updateId`.

   </details>

If your callback wants to cancel the described change from happening, simply
assign a value to the property being changed and it will take priority.

Note that callbacks are always called *for every matching change*, even if
changes essentially invalidate previous ones by overwriting their values.  Some
use-cases (such as updating a UI in response to property changes) may only care
about the final results at the end of this event loop tick, so you may wish to
accumulate the changes and defer your rendering with an API appropriate for
your use-case (such as [`setImmediate`][setImmediate],
[`process.nextTick`][processNextTick], [`queueMicrotask`][queueMicrotask],
[`requestAnimationFrame`][requestAnimationFrame], etc).

<details><summary>Example: Accumulating changes and deferring rendering using <code>process.nextTick</code></summary>

<!-- !test in defer -->

```js
const objerve = require('./main.js')
const ArrayKeyedMap = require('array-keyed-map')

const obj = objerve()
const accumulatedChanges = new ArrayKeyedMap()

const render = () => {
  // Put your expensive UI rendering code here
  console.log(Array.from(accumulatedChanges.entries()))
  accumulatedChanges.clear()
}

objerve.addListener(obj, ['a'],
  (newVal, oldVal, action, path) => {
    if (accumulatedChanges.size === 0) process.nextTick(render)
    if (!accumulatedChanges.has(path)) {
      accumulatedChanges.set(path, {newVal, oldVal})
    } else {
      accumulatedChanges.get(path).newVal = newVal
    }
  })

// Make a bunch of changes
obj.a = 1
obj.a = 2
obj.a = 3
```

The `render` function only gets called on next event loop tick tick, with the
total accumulated change from `undefined` to `3`, and none of the intermediate
states between:

<!-- !test out defer -->

```
[ [ [ 'a' ], { newVal: 3, oldVal: undefined } ] ]
```

</details>

## call order

When one change triggers multiple callbacks, the order they are called depends
on whether the change is constructive or destructive:   If the property is
being created or changed, callbacks are called in root→leaf bottom-up order.
If the property is being deleted, callbacks are called in leaf→root top-down
order.

Because of this feature, your listeners can setup or teardown state (e.g.
managing DOM elements) in response to creation or deletion, and sub-properties
can use that state (e.g. appending their own DOM elements to the parent's ones)
while still being able to clean up the sub-properties' state gracefully and in
the right order even when a whole chain of properties is deleted all at once.

<details><summary>Example: Construction and destruction call order</summary>

<!-- !test in call order -->
```js
const objerve = require('./main.js')
const obj = objerve()

const callback = (name) => {
  return (val, previousVal, action) => {
    console.log(`${action} ${name}`)
  }
}

objerve.addListener(obj, ['a'], callback('a'))
objerve.addListener(obj, ['a', 'b'], callback('a.b'))
objerve.addListener(obj, ['a', 'b', 'c'], callback('a.b.c'))

obj.a = { b: { c: 'value' } }
delete obj.a
```

<!-- !test out call order -->

> ```
> create a
> create a.b
> create a.b.c
> delete a.b.c
> delete a.b
> delete a
> ```
</details>

Prefix listeners and `objerve.each`-matching listeners are also considered
"parents" of concrete property paths, so their listeners are called before the
concrete path's listeners on creation/change (prefix→each→concrete), and after
them on deletion (concrete→each→prefix).

<details><summary>Example: Construction and destruction call order, with prefix- and <code>objerve.each</code>-listeners</summary>

<!-- !test in tree each call order -->
```js
const objerve = require('./main.js')
const obj = objerve([])

const callback = (name) => {
  return (val, previousVal, action) => console.log(`${action} ${name}`)
}

// Listen for property '0'
objerve.addListener(obj, [0], callback('concrete'))
// Listen for any array index
objerve.addListener(obj, [objerve.each], callback('each'))
// Listen for all properties
objerve.addPrefixListener(obj, [], callback('prefix'))

obj[0] = true
delete obj[0]
```
<!-- !test out tree each call order -->

> ```
> create prefix
> create each
> create concrete
> delete concrete
> delete each
> delete prefix
> ```
</details>

If there are multiple listeners for a property that changes, the listeners are
called in insertion order.

Other than the above rules, the relative order in which any two paths'
callbacks are called may be arbitrary, so you shouldn't rely on it.

## use-cases

 - Binding data to UI.
 - Testing.  Transparently adding logging to property changes is handy.
 - Reactive programming.

## license

[ISC](LICENSE); summary: use for anything, credit me, no warranty

[setImmediate]: https://developer.mozilla.org/en-US/docs/Web/API/Window/setImmediate
[processNextTick]: https://nodejs.org/api/process.html#process_process_nexttick_callback_args
[queueMicrotask]: https://developer.mozilla.org/en-US/docs/Web/API/WindowOrWorkerGlobalScope/queueMicrotask
[requestAnimationFrame]: https://developer.mozilla.org/en-US/docs/Web/API/window/requestAnimationFrame
