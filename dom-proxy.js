var global = typeof window !== 'undefined' ? window : self;

{
    // We need this because the `FinalizationGroup` can't keep itself alive somehow
    const gcGroups =  new Set()

    const I32_PARENT_LOCK_INDEX = 0
    const I32_CHILD_LOCK_INDEX = 1
    const I32_DATA_LENGTH_INDEX = 2
    const I32_DATA_INDEX = 3
    const DATA_LRNGTH_LIMIT = 1024 * 1024 - 8


    const COMMANDS = {
        GET_ROOT: 'GET_ROOT',
        GET_PROPERTY: 'GET_PROPERTY',
        GET_OWN_KEYS: 'GET_OWN_KEYS',
        GET_OWN_PROPERTY_DESCRIPTOR: 'GET_OWN_PROPERTY_DESCRIPTOR',
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


    var DOMProxy = global.DOMProxy = {
        gcGroups,
        constants: {
            OFFSETS: {
                I32_PARENT_LOCK_INDEX,
                I32_CHILD_LOCK_INDEX,
                I32_DATA_LENGTH_INDEX,
                I32_DATA_INDEX
            },
            LIMITS: {
                DATA_LRNGTH_LIMIT
            },
            COMMANDS,
            TYPES
        },
        createHost() {
            /**
             * @type {ArrayBuffer}
             */
            const buffer = new SharedArrayBuffer(1024 * 1024)
            const int32 = new Int32Array(buffer);
            const dataView = new DataView(buffer)

            let id = 0


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

            const payload = {
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
            }

            async function listen(handler) {
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

            let refId = 0
            const map = new Map()
            const backMap = new WeakMap()

            function format(item) {
                if (item === null) {
                    return { type: TYPES.NULL }
                } else if (item === undefined) {
                    return { type: TYPES.UNDEFINED }
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

            listen(function handler(requestText) {
                var request = JSON.parse(requestText)

                switch (request.command) {
                    case COMMANDS.GET_ROOT:
                        return JSON.stringify(format(window))
                    case COMMANDS.GET_PROPERTY:
                        var self = map.get(request.self)
                        var prop = request.prop
                        return JSON.stringify(format(self[prop]))
                    case COMMANDS.GET_OWN_KEYS:
                        var self = map.get(request.self)
                        var keys = Reflect.ownKeys(self).filter(i => typeof i === 'string')
                        return JSON.stringify(keys)
                    case COMMANDS.GET_OWN_PROPERTY_DESCRIPTOR:
                        var self = map.get(request.self)
                        var prop = request.prop
                        var desc = Object.getOwnPropertyDescriptor(self, prop)
                        delete desc.value
                        delete desc.get
                        delete desc.set
                        return JSON.stringify(desc)
                    case COMMANDS.UNREF:
                        map.delete(request.ref)
                        return JSON.stringify({ success: true })
                }

                return '{"error":"not implement"}'
            })

            return payload
        },

        createProxy(payload) {

            var data = payload
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

            const proxies = new Map()

            function createCleaner() {
                var gcGroup = new FinalizationGroup((refIds) => {
                    gcGroups.delete(gcGroup)
                    for (let refId of refIds) {
                        proxies.delete(refId)
                        send(JSON.stringify({ command: COMMANDS.UNREF, ref: refId }))
                    }
                })

                gcGroups.add(gcGroup)
                return gcGroup
            }

            function createProxy(refId) {
                if (proxies.has(refId)) {
                    return proxies.get(refId).deref()
                }

                var proxy = new Proxy({}, {
                    get: function (target, prop, receiver) {
                        var result = JSON.parse(send(JSON.stringify({ command: COMMANDS.GET_PROPERTY, self: refId, prop: prop })))

                        switch (result.type) {
                            case TYPES.NUMBER:
                            case TYPES.BOOLEAN:
                            case TYPES.STRING:
                                return result.value
                            case TYPES.NULL:
                                return null
                            case TYPES.UNDEFINED:
                                return undefined
                            case TYPES.OBJECT:
                                return createProxy(result.ref)
                        }
                    },
                    ownKeys: function (target) {
                        var result = JSON.parse(send(JSON.stringify({ command: COMMANDS.GET_OWN_KEYS, self: refId })))
                        return result;
                    },
                    getOwnPropertyDescriptor(target, prop) {
                        var result = JSON.parse(send(JSON.stringify({ command: COMMANDS.GET_OWN_PROPERTY_DESCRIPTOR, self: refId, prop })))
                        return Object.assign(result, { configurable: true })
                    }
                })

                const finalizerGroup = createCleaner(send, proxies)

                finalizerGroup.register(proxy, refId)
                proxies.set(refId, new WeakRef(proxy))

                return proxy
            }

            function getRoot() {
                var result = JSON.parse(send(JSON.stringify({ command: COMMANDS.GET_ROOT })))
                return createProxy(result.ref)
            }

            return getRoot()
        }
    }
}