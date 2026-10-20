# Code

## Fenced with backticks

```ts
export function add(a: number, b: number): number {
  return a + b;
}
```

```sh
pnpm install
pnpm test
```

```json
{ "name": "fixture", "private": true }
```

```
A fence with no info string.
```

## Fenced with tildes

~~~python
def greet(name: str) -> str:
    return f"hello, {name}"
~~~

~~~
Tilde fences may hold ``` backtick fences
```
like this one
```
without closing early.
~~~

## Longer fences

````md
```ts
const nested = "a fence inside a fence";
```
````

`````
A five-backtick fence closes only on five or more.
````
still inside
`````

## Info strings

```ts title="example.ts" {2}
const a = 1;
const b = 2;
```

```diff
- removed line
+ added line
```

## Indented code

    Indented code blocks are four spaces in.
    They have no fence to hide.

## Empty fence

```
```

## Code between paragraphs

Before the fence, a paragraph with `inline code`.

```js
console.log("between");
```

After the fence, another paragraph with **bold**.
