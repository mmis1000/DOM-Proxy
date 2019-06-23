async function main (handler) {
    /**
     * @type {ArrayBuffer}
     */
    const buffer = new SharedArrayBuffer(1024 * 1024)
    const int32 = new Int32Array(buffer);
    const dataView = new DataView(buffer)

    const myWorker = new Worker("worker.js?1");
    let id = 0

    const I32_PARENT_LOCK_INDEX = 0
    const I32_CHILD_LOCK_INDEX = 1
    const I32_DATA_LENGTH_INDEX = 2
    const I32_DATA_INDEX = 3
    const DATA_LRNGTH_LIMIT = 1024 * 1024 - 8

    const decoder = new TextDecoder()
    const encoder = new TextEncoder()

    /**
     * @param {ArrayBuffer} buffer
     */
    function parse(buffer, offset, length) {
        var slice = buffer.slice(offset, offset + length)
        var text = decoder.decode(new Uint8Array(new Uint8Array(slice)))
        return text
    }

    function write(buffer, offset, text) {
        var encodedBuffer = encoder.encode(text)
        new Uint8Array(buffer).set(encodedBuffer, offset)

        return encodedBuffer.byteLength
    }

    myWorker.postMessage({
        constants: {
            I32_PARENT_LOCK_INDEX,
            I32_CHILD_LOCK_INDEX,
            I32_DATA_LENGTH_INDEX,
            I32_DATA_INDEX,
            DATA_LRNGTH_LIMIT
        },
        buffer,
        int32,
        dataView
    })

    let old = 0;

    while (true) {

        await Atomics.waitAsync(int32, I32_PARENT_LOCK_INDEX, old)

        var length = dataView.getUint32(I32_DATA_LENGTH_INDEX * 4)
        var text = parse(buffer, I32_DATA_INDEX * 4, length)

        var writeLength = write(buffer, I32_DATA_INDEX * 4, await handler(text))
        dataView.setUint32(I32_DATA_LENGTH_INDEX * 4, writeLength)

        old = Atomics.load(int32, I32_PARENT_LOCK_INDEX)
        Atomics.store(int32, I32_CHILD_LOCK_INDEX, id++)
        Atomics.notify(int32, I32_CHILD_LOCK_INDEX)
    }
    
}

var COMMANDS = {
    GET_ROOT: 'GET_ROOT',
    GET_PROPERTY: 'GET_PROPERTY',
    UNREF: 'UNREF'
}

const TYPES = {
    NUMBER: 'NUMBER',
    BOOLEAN: 'NUMBER',
    STRING: 'STRING',
    NULL: 'NULL',
    UNDEFINED: 'UNDEFINED',
    OBJECT: 'OBJECT'
}

let refId = 0
const map = new Map()
const backMap = new WeakMap()

function format (item) {
    if (item === null) {
        return { type: TYPES.NULL }
    } else if (item === undefined) {
        return { type: TYPES.NULL }
    } else {
        switch (typeof item) {
            case "boolean":
                return { type: TYPES.BOOLEAN, value: item }
            case "number": 
                return { type: TYPES.NUMBER, value: item }
            case "string": 
                return { type: TYPES.STRING, value: item }
            case "function":
            case "object":
                var id
                if (!backMap.has(item)) {
                    id = refId++
                    map.set(id, item)
                    backMap.set(item, id)
                } else {
                    id = backMap.get(item)
                }

                return { type: TYPES.OBJECT, ref: id }
        }
    }
}

main(function handler (requestText) {
    var request = JSON.parse(requestText)

    switch (request.command) {
        case COMMANDS.GET_ROOT:
            return JSON.stringify(format(window))
        case COMMANDS.GET_PROPERTY:
            var self = map.get(request.self)
            var prop = request.prop
            return JSON.stringify(format(self[prop]))
        case COMMANDS.UNREF:
            map.delete(request.ref)
            return JSON.stringify({success: true})
    }

    return '{"error":"not implement"}'
})