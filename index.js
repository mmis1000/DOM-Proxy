/**
 * @type {ArrayBuffer}
 */
const buffer = new SharedArrayBuffer(1024 * 1024)
const int32 = new Int32Array(buffer);
const dataView = new DataView(buffer)

const myWorker = new Worker("worker.js");
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
    var slice = buffer.slice(offset)
    var encodedBuffer = encoder.encode(text, new Uint8Array(slice))
    new Uint8Array(buffer).set(encodedBuffer, offset)

    return encodedBuffer.byteLength
}

async function main () {

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

        console.log('main: received requset ', text, Date.now())

        var writeLength = write(buffer, I32_DATA_INDEX * 4, '[Callback] ' + text)
        dataView.setUint32(I32_DATA_LENGTH_INDEX * 4, writeLength)

        old = Atomics.load(int32, I32_PARENT_LOCK_INDEX)
        Atomics.store(int32, I32_CHILD_LOCK_INDEX, id++)
        Atomics.notify(int32, I32_CHILD_LOCK_INDEX)
    }
    
}

main()