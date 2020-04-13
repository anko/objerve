# objerve

define callbacks listening for changes inside given object paths

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

```
create a.b: undefined -> "hi"
change a.b: "hi" -> "hello"
delete a.b: "hello" -> undefined
```

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

Some notes on the order listeners are called:

 - Multiple callbacks for the same path are called in insertion order.

   *For example*, if you have 2 listeners for `['a', 'b']`, the one added first
   is called first.

 - If a change would call listeners at multiple levels of one path, they are
   called in root→leaf order for created or changed properties, and in
   leaf→root order for deletions.  This lets your callbacks setup and teardown
   state with correct nesting.

   *For example*, if you have listeners for `['a']` and `['a', 'b']` and both
   are called by the same change, then `['a']` is called first for property
   creations and changes (root→leaf), but `['a', 'b']` is called first for
   deletions (leaf→root).

 - Listeners that are siblings are called [in the standard order `Object.keys`
   uses](https://www.ecma-international.org/ecma-262/9.0/index.html#sec-ordinaryownpropertykeys)
   (value-order integers → insertion-order Strings → insertion-order Symbols).

   *For example*, if you have a listener for `['a', 'b']` and `['a', 'c']`,
   that are both called by the same change, then the one defined first is
   called first.

 - More specific listeners are called before more general ones.  A named
   property is highest priority, followed by `objerve.each`, followed by prefix
   listeners.

   *For example*, when the property `obj.x.y` changes, the listener for ['x',
   'y'] is called before the prefix listener for `['x']`.


# use-cases

 - Binding data to UI components.
 - Testing.  Transparently add logging to property changes on objects.
 - Creating objects that react to their own paths changing
