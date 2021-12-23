const decoder = new TextDecoder();
const RedisError = class RedisError extends Error {
  get name() {
    return this.constructor.name;
  }
};
const ReplyError = class ReplyError extends RedisError {
  constructor(message) {
    const tmp = Error.stackTraceLimit;
    Error.stackTraceLimit = 2;
    super(message);
    Error.stackTraceLimit = tmp;
  }
  get name() {
    return this.constructor.name;
  }
};
const ParserError = class ParserError extends RedisError {
  constructor(message, buffer, offset) {
    const tmp = Error.stackTraceLimit;
    Error.stackTraceLimit = 2;
    super(message);
    Error.stackTraceLimit = tmp;
    this.offset = offset;
    this.buffer = buffer;
  }
  get name() {
    return this.constructor.name;
  }
};
const Parser = (function () {
  var bufferPool = new ArrayBuffer(32 * 1024);
  var bufferOffset = 0;
  var interval = null;
  var counter = 0;
  var notDecreased = 0;
  function parseSimpleNumbers(parser) {
    const length = parser.buffer.byteLength - 1;
    var offset = parser.offset;
    var number = 0;
    var sign = 1;
    if (parser.buffer[offset] === 45) {
      sign = -1;
      offset++;
    }
    while (offset < length) {
      const c1 = parser.buffer[offset++];
      if (c1 === 13) {
        parser.offset = offset + 1;
        return sign * number;
      }
      number = number * 10 + (c1 - 48);
    }
  }
  function parseStringNumbers(parser) {
    const length = parser.buffer.byteLength - 1;
    var offset = parser.offset;
    var number = 0;
    var res = "";
    if (parser.buffer[offset] === 45) {
      res += "-";
      offset++;
    }
    while (offset < length) {
      var c1 = parser.buffer[offset++];
      if (c1 === 13) {
        parser.offset = offset + 1;
        if (number !== 0) {
          res += number;
        }
        return res;
      } else if (number > 429496728) {
        res += number * 10 + (c1 - 48);
        number = 0;
      } else if (c1 === 48 && number === 0) {
        res += 0;
      } else {
        number = number * 10 + (c1 - 48);
      }
    }
  }
  function parseSimpleString(parser) {
    const start = parser.offset;
    const buffer = parser.buffer;
    const length = buffer.byteLength - 1;
    var offset = start;
    while (offset < length) {
      if (buffer[offset++] === 13) {
        parser.offset = offset + 1;
        if (parser.optionReturnBuffers === true) {
          return parser.buffer.slice(start, offset - 1);
        } else {
          return decoder.decode(parser.buffer.subarray(start, offset - 1));
        }
      }
    }
  }
  function parseLength(parser) {
    const length = parser.buffer.byteLength - 1;
    var offset = parser.offset;
    var number = 0;
    while (offset < length) {
      const c1 = parser.buffer[offset++];
      if (c1 === 13) {
        parser.offset = offset + 1;
        return number;
      }
      number = number * 10 + (c1 - 48);
    }
  }
  function parseInteger(parser) {
    if (parser.optionStringNumbers === true) {
      return parseStringNumbers(parser);
    }
    return parseSimpleNumbers(parser);
  }
  function parseBulkString(parser) {
    const length = parseLength(parser);
    if (length === undefined) {
      return;
    }
    if (length < 0) {
      return null;
    }
    const offset = parser.offset + length;
    if (offset + 2 > parser.buffer.byteLength) {
      parser.bigStrSize = offset + 2;
      parser.totalChunkSize = parser.buffer.byteLength;
      parser.bufferCache.push(parser.buffer);
      return;
    }
    const start = parser.offset;
    parser.offset = offset + 2;
    if (parser.optionReturnBuffers === true) {
      return parser.buffer.slice(start, offset);
    } else {
      return decoder.decode(parser.buffer.subarray(start, offset));
    }
  }
  function parseError(parser) {
    var string = parseSimpleString(parser);
    if (string !== undefined) {
      if (parser.optionReturnBuffers === true) {
        string = string.toString();
      }
      return new ReplyError(string);
    }
  }
  function handleError(parser, type) {
    const err = new ParserError("Protocol error, got " + JSON.stringify(String.fromCharCode(type)) + " as reply type byte", JSON.stringify(parser.buffer), parser.offset);
    parser.buffer = null;
    parser.returnFatalError(err);
  }
  function parseArray(parser) {
    const length = parseLength(parser);
    if (length === undefined) {
      return;
    }
    if (length < 0) {
      return null;
    }
    const responses = new Array(length);
    return parseArrayElements(parser, responses, 0);
  }
  function pushArrayCache(parser, array, pos) {
    parser.arrayCache.push(array);
    parser.arrayPos.push(pos);
  }
  function parseArrayChunks(parser) {
    const tmp = parser.arrayCache.pop();
    var pos = parser.arrayPos.pop();
    if (parser.arrayCache.length) {
      const res = parseArrayChunks(parser);
      if (res === undefined) {
        pushArrayCache(parser, tmp, pos);
        return;
      }
      tmp[pos++] = res;
    }
    return parseArrayElements(parser, tmp, pos);
  }
  function parseArrayElements(parser, responses, i) {
    const bufferLength = parser.buffer.length;
    while (i < responses.length) {
      const offset = parser.offset;
      if (parser.offset >= bufferLength) {
        pushArrayCache(parser, responses, i);
        return;
      }
      const response = parseType(parser, parser.buffer[parser.offset++]);
      if (response === undefined) {
        if (!(parser.arrayCache.length || parser.bufferCache.length)) {
          parser.offset = offset;
        }
        pushArrayCache(parser, responses, i);
        return;
      }
      responses[i] = response;
      i++;
    }
    return responses;
  }
  function parseType(parser, type) {
    switch (type) {
      case 36:
        return parseBulkString(parser);
      case 43:
        return parseSimpleString(parser);
      case 42:
        return parseArray(parser);
      case 58:
        return parseInteger(parser);
      case 45:
        return parseError(parser);
      default:
        return handleError(parser, type);
    }
  }
  function decreaseBufferPool() {
    if (bufferPool.byteLength > 50 * 1024) {
      if (counter === 1 || notDecreased > counter * 2) {
        const minSliceLen = Math.floor(bufferPool.byteLength / 10);
        const sliceLength = minSliceLen < bufferOffset ? bufferOffset : minSliceLen;
        bufferOffset = 0;
        bufferPool = bufferPool.slice(sliceLength, bufferPool.byteLength);
      } else {
        notDecreased++;
        counter--;
      }
    } else {
      clearInterval(interval);
      counter = 0;
      notDecreased = 0;
      interval = null;
    }
  }
  function resizeBuffer(length) {
    if (bufferPool.byteLength < length + bufferOffset) {
      const multiplier = length > 1024 * 1024 * 75 ? 2 : 3;
      if (bufferOffset > 1024 * 1024 * 111) {
        bufferOffset = 1024 * 1024 * 50;
      }
      bufferPool = new Uint8Array(length * multiplier + bufferOffset);
      bufferOffset = 0;
      counter++;
      if (interval === null) {
        interval = setInterval(decreaseBufferPool, 50);
      }
    }
  }
  function concatBulkString(parser) {
    const list = parser.bufferCache;
    const oldOffset = parser.offset;
    var chunks = list.length;
    var offset = parser.bigStrSize - parser.totalChunkSize;
    parser.offset = offset;
    if (offset <= 2) {
      if (chunks === 2) {
        return list[0].toString("utf8", oldOffset, list[0].length + offset - 2);
      }
      chunks--;
      offset = list[list.length - 2].length + offset;
    }
    var res = decoder.write(list[0].slice(oldOffset));
    for (var i = 1; i < chunks - 1; i++) {
      res += decoder.write(list[i]);
    }
    res += decoder.end(list[i].slice(0, offset - 2));
    return res;
  }
  function concatBulkBuffer(parser) {
    const list = parser.bufferCache;
    const oldOffset = parser.offset;
    const length = parser.bigStrSize - oldOffset - 2;
    var chunks = list.length;
    var offset = parser.bigStrSize - parser.totalChunkSize;
    parser.offset = offset;
    if (offset <= 2) {
      if (chunks === 2) {
        return list[0].slice(oldOffset, list[0].length + offset - 2);
      }
      chunks--;
      offset = list[list.length - 2].length + offset;
    }
    resizeBuffer(length);
    const start = bufferOffset;
    list[0].copy(bufferPool, start, oldOffset, list[0].length);
    bufferOffset += list[0].length - oldOffset;
    for (var i = 1; i < chunks - 1; i++) {
      list[i].copy(bufferPool, bufferOffset);
      bufferOffset += list[i].length;
    }
    list[i].copy(bufferPool, bufferOffset, 0, offset - 2);
    bufferOffset += offset - 2;
    return bufferPool.slice(start, bufferOffset);
  }
  class JavascriptRedisParser {
    constructor(options) {
      if (!options) {
        throw new TypeError("Options are mandatory.");
      }
      if (typeof options.returnError !== "function" || typeof options.returnReply !== "function") {
        throw new TypeError("The returnReply and returnError options have to be functions.");
      }
      this.setReturnBuffers(!!options.returnBuffers);
      this.setStringNumbers(!!options.stringNumbers);
      this.returnError = options.returnError;
      this.returnFatalError = options.returnFatalError || options.returnError;
      this.returnReply = options.returnReply;
      this.reset();
    }
    reset() {
      this.offset = 0;
      this.buffer = null;
      this.bigStrSize = 0;
      this.totalChunkSize = 0;
      this.bufferCache = [];
      this.arrayCache = [];
      this.arrayPos = [];
    }
    setReturnBuffers(returnBuffers) {
      if (typeof returnBuffers !== "boolean") {
        throw new TypeError("The returnBuffers argument has to be a boolean");
      }
      this.optionReturnBuffers = returnBuffers;
    }
    setStringNumbers(stringNumbers) {
      if (typeof stringNumbers !== "boolean") {
        throw new TypeError("The stringNumbers argument has to be a boolean");
      }
      this.optionStringNumbers = stringNumbers;
    }
    execute(buffer) {
      buffer = new Uint8Array(buffer);
      if (this.buffer === null) {
        this.buffer = buffer;
        this.offset = 0;
      } else if (this.bigStrSize === 0) {
        const oldLength = this.buffer.byteLength;
        const remainingLength = oldLength - this.offset;
        const newBuffer = new Uint8Array(remainingLength + buffer.byteLength);
        newBuffer.set(this.buffer.subarray(this.offset, oldLength), 0);
        newBuffer.set(buffer.subarray(0, buffer.byteLength), remainingLength);
        this.buffer = newBuffer;
        this.offset = 0;
        if (this.arrayCache.length) {
          const arr = parseArrayChunks(this);
          if (arr === undefined) {
            return;
          }
          this.returnReply(arr);
        }
      } else if (this.totalChunkSize + buffer.byteLength >= this.bigStrSize) {
        this.bufferCache.push(buffer);
        var tmp = this.optionReturnBuffers ? concatBulkBuffer(this) : concatBulkString(this);
        this.bigStrSize = 0;
        this.bufferCache = [];
        this.buffer = buffer;
        if (this.arrayCache.length) {
          this.arrayCache[0][this.arrayPos[0]++] = tmp;
          tmp = parseArrayChunks(this);
          if (tmp === undefined) {
            return;
          }
        }
        this.returnReply(tmp);
      } else {
        this.bufferCache.push(buffer);
        this.totalChunkSize += buffer.length;
        return;
      }
      while (this.offset < this.buffer.byteLength) {
        const offset = this.offset;
        const type = this.buffer[this.offset++];
        const response = parseType(this, type);
        if (response === undefined) {
          if (!(this.arrayCache.length || this.bufferCache.length)) {
            this.offset = offset;
          }
          return;
        }
        if (type === 45) {
          this.returnError(response);
        } else {
          this.returnReply(response);
        }
      }
      this.buffer = null;
    }
  }
  return JavascriptRedisParser;
})();
const equal = function equal(buf1, buf2) {
  if (buf1.byteLength != buf2.byteLength) return false;
  for (var i = 0; i != buf1.byteLength; i++) {
    if (buf1[i] != buf2[i]) return false;
  }
  return true;
};
const encoder = new TextEncoder();
const C = {
  PUB_SUB_MESSAGES: {
    message: encoder.encode("message"),
    pMessage: encoder.encode("pmessage"),
    subscribe: encoder.encode("subscribe"),
    pSubscribe: encoder.encode("psubscribe"),
    unsubscribe: encoder.encode("unsunscribe"),
    pUnsubscribe: encoder.encode("punsubscribe")
  },
  PubSubSubscribeCommands: {
    SUBSCRIBE: "SUBSCRIBE",
    PSUBSCRIBE: "PSUBSCRIBE"
  },
  PubSubUnsubscribeCommands: {
    UNSUBSCRIBE: "UNSUBSCRIBE",
    PUNSUBSCRIBE: "PUNSUBSCRIBE"
  }
};
const AbortError = class AbortError extends RedisError {
  get name() {
    return this.constructor.name;
  }
};
const RedisCommandsQueue = class RedisCommandsQueue {
  static flushQueue(queue, err) {
    while (queue.length) {
      queue.shift().reject(err);
    }
  }
  static emitPubSubMessage(listenersMap, message, channel, pattern) {
    const keyString = decoder.decode(pattern || channel), listeners = listenersMap.get(keyString);
    if (!listeners) return;
    for (const listener of listeners.buffers) {
      listener(message, channel);
    }
    if (!listeners.strings.size) return;
    const messageString = decoder.decode(message), channelString = pattern ? decoder.decode(channel) : keyString;
    for (const listener of listeners.strings) {
      listener(messageString, channelString);
    }
  }
  constructor(maxLength = 10000) {
    this.waitingToBeSent = [];
    this.waitingForReply = [];
    this.maxLength = maxLength;
    this.parser = new Parser({
      returnReply: reply => {
        if (this.pubSubState && Array.isArray(reply)) {
          if (equal(C.PUB_SUB_MESSAGES.message, reply[0])) {
            return RedisCommandsQueue.emitPubSubMessage(this.pubSubState.listeners.channels, reply[2], reply[1]);
          } else if (equal(C.PUB_SUB_MESSAGES.pMessage, reply[0])) {
            return RedisCommandsQueue.emitPubSubMessage(this.pubSubState.listeners.patterns, reply[3], reply[2], reply[1]);
          } else if (equal(C.PUB_SUB_MESSAGES.subscribe, reply[0]) || equal(C.PUB_SUB_MESSAGES.pSubscribe.equals, reply[0]) || equal(C.PUB_SUB_MESSAGES.unsubscribe.equals, reply[0]) || equal(C.PUB_SUB_MESSAGES.pUnsubscribe.equals, reply[0])) {
            if (--this.waitingForReply[0].channelsCounter === 0) {
              this.shiftWaitingForReply().resolve();
            }
            return;
          }
        }
        this.shiftWaitingForReply().resolve(reply);
      },
      returnError: err => this.shiftWaitingForReply().reject(err)
    });
  }
  addCommand(args, options) {
    if (this.pubSubState && !options?.ignorePubSubMode) {
      return Promise.reject(new Error("Cannot send commands in PubSub mode"));
    } else if (this.maxLength && this.waitingToBeSent.length + this.waitingForReply.length >= this.maxLength) {
      return Promise.reject(new Error("The queue is full"));
    } else if (options?.signal?.aborted) {
      return Promise.reject(new AbortError());
    }
    return new Promise((resolve, reject) => {
      const node = {
        args,
        chainId: options?.chainId,
        returnBuffers: options?.returnBuffers,
        resolve,
        reject
      };
      if (options?.signal) {
        const listener = () => {
          this.waitingToBeSent.removeNode(node);
          node.value.reject(new AbortError());
        };
        node.value.abort = {
          signal: options.signal,
          listener
        };
        options.signal.addEventListener("abort", listener, {
          once: true
        });
      }
      if (options?.asap) {
        this.waitingToBeSent.unshift(node);
      } else {
        this.waitingToBeSent.push(node);
      }
    });
  }
  initiatePubSubState() {
    return this.pubSubState ??= {
      subscribed: 0,
      subscribing: 0,
      unsubscribing: 0,
      listeners: {
        channels: new Map(),
        patterns: new Map()
      }
    };
  }
  subscribe(command, channels, listener, returnBuffers) {
    const pubSubState = this.initiatePubSubState(), channelsToSubscribe = [], listenersMap = command === C.PubSubSubscribeCommands.SUBSCRIBE ? pubSubState.listeners.channels : pubSubState.listeners.patterns;
    for (const channel of Array.isArray(channels) ? channels : [channels]) {
      const channelString = typeof channel === "string" ? channel : channel.toString();
      let listeners = listenersMap.get(channelString);
      if (!listeners) {
        listeners = {
          buffers: new Set(),
          strings: new Set()
        };
        listenersMap.set(channelString, listeners);
        channelsToSubscribe.push(channel);
      }
      (returnBuffers ? listeners.buffers : listeners.strings).add(listener);
    }
    if (!channelsToSubscribe.length) {
      return Promise.resolve();
    }
    return this.pushPubSubCommand(command, channelsToSubscribe);
  }
  unsubscribe(command, channels, listener, returnBuffers) {
    if (!this.pubSubState) {
      return Promise.resolve();
    }
    const listeners = command === C.PubSubUnsubscribeCommands.UNSUBSCRIBE ? this.pubSubState.listeners.channels : this.pubSubState.listeners.patterns;
    if (!channels) {
      const size = listeners.size;
      listeners.clear();
      return this.pushPubSubCommand(command, size);
    }
    const channelsToUnsubscribe = [];
    for (const channel of Array.isArray(channels) ? channels : [channels]) {
      const sets = listeners.get(channel);
      if (!sets) continue;
      let shouldUnsubscribe;
      if (listener) {
        (returnBuffers ? sets.buffers : sets.strings).delete(listener);
        shouldUnsubscribe = !sets.buffers.size && !sets.strings.size;
      } else {
        shouldUnsubscribe = true;
      }
      if (shouldUnsubscribe) {
        channelsToUnsubscribe.push(channel);
        listeners.delete(channel);
      }
    }
    if (!channelsToUnsubscribe.length) {
      return Promise.resolve();
    }
    return this.pushPubSubCommand(command, channelsToUnsubscribe);
  }
  pushPubSubCommand(command, channels) {
    return new Promise((resolve, reject) => {
      const pubSubState = this.initiatePubSubState(), isSubscribe = command === C.PubSubSubscribeCommands.SUBSCRIBE || command === C.PubSubSubscribeCommands.PSUBSCRIBE, inProgressKey = isSubscribe ? "subscribing" : "unsubscribing", commandArgs = [command];
      let channelsCounter;
      if (typeof channels === "number") {
        channelsCounter = channels;
      } else {
        commandArgs.push(...channels);
        channelsCounter = channels.length;
      }
      pubSubState[inProgressKey] += channelsCounter;
      this.waitingToBeSent.push({
        args: commandArgs,
        channelsCounter,
        returnBuffers: true,
        resolve: () => {
          pubSubState[inProgressKey] -= channelsCounter;
          if (isSubscribe) {
            pubSubState.subscribed += channelsCounter;
          } else {
            pubSubState.subscribed -= channelsCounter;
            if (!pubSubState.subscribed && !pubSubState.subscribing && !pubSubState.subscribed) {
              this.pubSubState = undefined;
            }
          }
          resolve();
        },
        reject: err => {
          pubSubState[inProgressKey] -= channelsCounter * (isSubscribe ? 1 : -1);
          reject(err);
        }
      });
    });
  }
  resubscribe() {
    if (!this.pubSubState) {
      return;
    }
    this.pubSubState.subscribed = 0;
    const promises = [], {channels, patterns} = this.pubSubState.listeners;
    if (channels.size) {
      promises.push(this.pushPubSubCommand(C.PubSubSubscribeCommands.SUBSCRIBE, [...channels.keys()]));
    }
    if (patterns.size) {
      promises.push(this.pushPubSubCommand(C.PubSubSubscribeCommands.PSUBSCRIBE, [...patterns.keys()]));
    }
    if (promises.length) {
      return Promise.all(promises);
    }
  }
  getCommandToSend() {
    const toSend = this.waitingToBeSent.shift();
    if (toSend) {
      this.waitingForReply.push({
        resolve: toSend.resolve,
        reject: toSend.reject,
        channelsCounter: toSend.channelsCounter,
        returnBuffers: toSend.returnBuffers
      });
    }
    this.chainInExecution = toSend?.chainId;
    return toSend?.args;
  }
  parseResponse(data) {
    this.parser.setReturnBuffers(!!this.waitingForReply[0]?.returnBuffers || !!this.pubSubState?.subscribed);
    this.parser.execute(data);
  }
  shiftWaitingForReply() {
    if (!this.waitingForReply.length) {
      throw new Error("Got an unexpected reply from Redis");
    }
    return this.waitingForReply.shift();
  }
  flushWaitingForReply(err) {
    RedisCommandsQueue.flushQueue(this.waitingForReply, err);
    if (!this.chainInExecution) {
      return;
    }
    while (this.waitingToBeSent.head?.value.chainId === this.chainInExecution) {
      this.waitingToBeSent.shift();
    }
    this.chainInExecution = undefined;
  }
  flushAll(err) {
    RedisCommandsQueue.flushQueue(this.waitingForReply, err);
    RedisCommandsQueue.flushQueue(this.waitingToBeSent, err);
  }
};
const encodeCommand = function* encodeCommand(args) {
  let strings = `*${args.length}\r\n`, stringsLength = 0;
  for (const arg of args) {
    const isString = typeof arg === "string", byteLength = isString ? encoder.encode(arg).length : arg.byteLength;
    strings += `$${byteLength}\r\n`;
    if (isString) {
      const totalLength = stringsLength + byteLength;
      if (totalLength > 1024) {
        yield strings;
        strings = arg;
        stringsLength = byteLength;
      } else {
        strings += arg;
        stringsLength = totalLength;
      }
    } else {
      yield strings;
      strings = "";
      stringsLength = 0;
      yield arg;
    }
    strings += "\r\n";
  }
  yield strings;
};
export const createClient = async function createClient({socket = {
  host: "localhost",
  port: 6380,
  tls: false
}, url = undefined, username = undefined, password = undefined, name = undefined, database = undefined} = {}) {
  const queue = new RedisCommandsQueue();
  const ws = new WebSocket(`ws${socket.tls ? "s" : ""}://${socket.host}:${socket.port}`);
  ws.binaryType = "arraybuffer";
  ws.onmessage = evt => {
    queue.parseResponse(evt.data);
  };
  const tick = () => {
    while (true) {
      const args = queue.getCommandToSend();
      if (args === undefined) break;
      writeCommand(args);
    }
  };
  const sendCommand = (args, options) => {
    const reply = queue.addCommand(args, options);
    tick();
    return reply;
  };
  const writeCommand = args => {
    for (const toWrite of encodeCommand(args)) {
      ws.send(toWrite);
    }
  };
  await new Promise((resolve, reject) => {
    ws.onclose = evt => reject(evt.code);
    ws.onopen = resolve;
  });
  if (username || password) {
    if (!username) sendCommand(["AUTH", password]); else sendCommand(["AUTH", username, password], {
      asap: true
    });
  }
  if (database) {
    sendCommand(["SELECT", database], {
      asap: true
    });
  }
  return {
    sendCommand,
    subscribe: (channels, listener, bufferMode) => {
      const reply = queue.subscribe(C.PubSubSubscribeCommands.SUBSCRIBE, channels, listener, bufferMode);
      tick();
      return reply;
    }
  };
};
