# web-redis

Client for the Redis protocol that communicates over websockets. To use, you must have a websocket to TCP bridge. The code, documentation and tests are hosted on [observablehq.com/@tomlarkworthy/redis](https://observablehq.com/@tomlarkworthy/redis)


## Example usage
```js
import {createClient} from 'https://unpkg.com/web-redis';
const client = await createClient({
  socket: {
    host: "localhost",
    port: 6380,
    tls: false
  },
  database: "myDatabase"
});

client.sendCommand(["SET", "k1", "foobar"]);

const result = await client.sendCommand(["GET", "k1"]);
// result == "foobar"
```

## Example on Observablehq

Find examples and tests on Observablehq at
[observablehq.com/@tomlarkworthy/redis](https://observablehq.com/@tomlarkworthy/redis)

## Example on Codepen

A working example (provided you have a websockify bridge) on the web

https://codepen.io/tomlarkworthy/pen/BawwWGP
