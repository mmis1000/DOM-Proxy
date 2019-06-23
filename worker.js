function main (callback) {
    self.addEventListener('message', function (event) {
        console.log('recieve', event)
        var data = event.data
        var buffer = data.buffer
        var int32 = data.int32
        var constants = data.constants
        var dataView = data.dataView
        let id = 0
    
        const decoder = new TextDecoder()
        const encoder = new TextEncoder()
        
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
    
        var send = (text) => {
            var length = write(buffer, constants.I32_DATA_INDEX * 4, text)
            dataView.setUint32(constants.I32_DATA_LENGTH_INDEX * 4, length)
    
            const old = Atomics.load(int32, constants.I32_CHILD_LOCK_INDEX)
            Atomics.store(int32, constants.I32_PARENT_LOCK_INDEX, id++)
            Atomics.notify(int32, constants.I32_PARENT_LOCK_INDEX)
            Atomics.wait(int32, constants.I32_CHILD_LOCK_INDEX, old)
    
            var length = dataView.getUint32(constants.I32_DATA_LENGTH_INDEX * 4)
            var text = parse(buffer, constants.I32_DATA_INDEX * 4, length)
    
            return text
        }
    
        callback(send)
    })
}

main(function (send) {
    const start = Date.now()

    for (var i = 0; i < 1000; i++) {
        const result = send('test message ' + i)
        console.log('worker: response ' + result)
    }

    console.log('end', Date.now() - start, 'average', (Date.now() - start) / 1000)
})