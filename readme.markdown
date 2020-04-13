# objerve

Define callbacks listening for changes inside given object paths.  Supports
path prefixes, array index wildcards, and [calls your listeners in a smart
order](#call-order).

# example

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

# api

## `objerve([obj])`

Wrap the given initial object (if none given, `{}`) so that it can be
subscribed to.

The resulting object behaves like a normal object, but changes to its paths can
be listened to with `objerve.addListener`.

## `objerve.addListener(obj, path, callback)`

The path can contain `objerve.each`, which will match any Array index at that
position.

Works inside listener callbacks.  If you add a listener for the same path
inside a callback for that path, the new listener will also be called with the
same change.

## `objerve.removeListener(obj, path, callback)`

Remove the listener from the given path, so the callback is no longer called.
The path is useful to disambiguate in case the same callback function is being
used as the listener for multiple paths.

Does nothing if it cannot find such a listener.

Works inside listener callbacks.  If you remove a listener for the same path
inside a callback for that path, the removed listener won't be called for that
change either (unless it was already called before you).

## `objerve.addPrefixListener(obj, path, callback)`

Same as `addListener`, but will be called for any property at all that has the
given `path` as a prefix.  Pass `[]` for the path to be called for every change
to any property.

## `objerve.removePrefixListener(obj, path, callback)`

Same as `removeListener`, but for prefix listeners.

# call order

When one change triggers multiple callbacks, they are called in increasing
order of specificity (root→leaf) when the change is a property creation or
change, and in decreasing order of specificity (leaf→root) when the change is a
deletion.  This maintains correct nesting order, so if your listeners further
out want to setup or teardown state that is used by listeners further in, they
can do so.

<details><summary>Example</summary>

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

obj.a = { b: 'hi' }
delete obj.a
```

<!-- !test out call order -->

> ```
> create a
> create a.b
> delete a.b
> delete a
> ```
</details>

The same applies if one property matches a prefix listener, `object.each`, or
concrete property.  Prefix listeners are considered the least specific, and
concrete properties the most specific, and they are called in root→leaf for
creation and changes, and leaf→root for deletions.

<details><summary>Example</summary>

<!-- !test in tree each call order -->
```js
const objerve = require('./main.js')
const obj = objerve([])

const callback = (name) => {
  return (val, previousVal, action) => {
    console.log(`${action} ${name}`)
  }
}

objerve.addListener(obj, [0], callback('index'))
objerve.addListener(obj, [objerve.each], callback('each'))
objerve.addPrefixListener(obj, [], callback('prefix'))

obj[0] = true
delete obj[0]
```
<!-- !test out tree each call order -->

> ```
> create prefix
> create each
> create index
> delete index
> delete each
> delete prefix
> ```
</details>

Callback order is not otherwise specified.

# use-cases

 - Binding data to UI components.
 - Testing.  Transparently add logging to property changes on objects.
 - Creating objects that react to their own paths changing
