# objerve

define callbacks listening for changes inside given object paths

# example

<!-- !test program node -->

<!-- !test in first example -->
```js
const objerve = require('./main.js')

const obj = objerve()

objerve.addListener(obj, ['a', 'b'], (action, path, newValue, oldValue) => {
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

The resulting object behaves like a normal object, but it can be
`objerve.subscribe`d to.

## `objerve.addListener(obj, path, callback)`

The path can contain `objerve.each`, which will call the callback for every key
of an Object or Array at that position.  The keys it sees are the same set as
`Object.getOwnPropertyNames` can see; no `Symbol`s or inherited properties.

If a change would call listeners at multiple levels of the hierarchy, they are
called in root→leaf order for created or changed properties, and in leaf→root
order for deletions.  This lets your callbacks setup and teardown state with
correct nesting.

If you have multiple callbacks for the same path, they might be called in any
order; don't rely on it.

# use-cases

 - Binding data to UI components.
 - Testing.  Transparently add logging to property changes on objects.
 - Creating objects that react to their own paths changing
