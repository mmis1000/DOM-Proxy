// @ts-check

if (typeof globalThis === 'undefined') {
    // @ts-ignore
    globalThis = typeof window !== 'undefined' ? window:
        typeof self !== 'undefined' ? self :
        typeof global !== 'undefined' ? global :
        (new Function('return this'))()
}

globalThis.DomProxy = {
    /**
    * create the dom proxy
    * @param {Int32Array} ia32 
    * @param {()=>any} getRoot 
    * @param {ListenOptions} [options] passed to the rpc layer (timeout, heartbeat)
    */   
    create: function create(ia32, getRoot, options) {
        const rpc = listen(listener, ia32, options)
    
        const currentThread = rpc.current
        const rpcSend = /** @type {RpcSend} */(rpc.send)
    
        const rpcSendMayThrow = /** @type {RpcSendWithThrow} */(
            (
            /** @type {number} */to, 
            /** @type {Command} */command
            ) => {
                if (to === currentThread) {
                    console.trace('you can\'t send to yourself!!!')
                    debugger
                    throw new Error('err')
                }
                // @ts-ignore
                var result = rpcSend(to, command)
                if (result.error != null) {
                    throw convertToRaw(result.error)
                }
                return result
            }
        )
    
        let currentObjectId = 1;
    
        /**
         * split the owner and object id
         * @param {number} num 
         */
        function getOwnerAndId(num) {
            return [num & 0xff, (num & 0xffffff00) >> 8]
        }
    
        /**
         * merge the owner and object id
         * @param {number} owner 
         * @param {number} id 
         */
        function getMergedId(owner, id) {
            return owner | (id << 8)
        }
    
        /**
         * @extends { WeakMap<T, U> }
         * @template {{}} T
         * @template U
         */
        class AutoMap extends WeakMap {
            /**
             * @param {U} defaultValue 
             */
            constructor(defaultValue) {
                super()
                this.defaultValue = defaultValue
            }
            /**
             * @param {T} key 
             */
            get(key) {
                const result = super.get(key)
                if (result == null) return this.defaultValue;
                return result
            }
        }
    
        /**
         * @type {AutoMap<any, number>}
         */
        const selfRefs = new AutoMap(0)
    
        /**
         * @type {Map<number, any>}
         */
        const selfIdToItem = new Map()
    
        /**
         * @type {WeakMap<any, number>}
         */
        const selfItemToId = new WeakMap()
    
        /**
         * @type {WeakMap<any, number>}
         */
        const remoteObjectToId = new WeakMap()
    
        /**
         * @type {Map<number, WeakRef<any>>}
         */
        const remoteIdToObject = new Map()
    
        /**
         * check if it is a remote object
         * @param {any} obj 
         * @returns {boolean}
         */
        function isRemote(obj) {
            return remoteObjectToId.has(obj)
        }
        /**
         * check if it is a remote object
         * @param {number} num 
         * @returns {boolean}
         */
        function isRemoteId(num) {
            return getOwnerAndId(num)[0] !== currentThread
        }
    
        /**
         * ids of collected proxies, waiting to be unref'd in one batch
         * @type {number[]}
         */
        const collectedIds = []

        function flushCollected() {
            const ids = collectedIds.splice(0)

            try {
                batchUnref(() => {
                for (let id of ids) {
                    // the id may have been fetched again (and got a new proxy) after the old one was collected
                    const ref = remoteIdToObject.get(id)
                    if (ref && ref.deref() === undefined) {
                        remoteIdToObject.delete(id)
                    }

                    // every proxy took one ref when created, so every collected proxy gives one back
                    unrefRemote(id)
                }
                })
            } catch (err) {
                // the owner may be gone (dead thread), nothing left to release then
                console.error(err)
            }
        }

        /**
         * FinalizationRegistry calls back once per collected proxy, batch them up
         * @type {FinalizationRegistry<number>}
         */
        const cleaner = new FinalizationRegistry(id => {
            if (collectedIds.length === 0) {
                setTimeout(flushCollected, 0)
            }
            collectedIds.push(id)
        })
        
        DomProxy.__finalizationRegistries.push(cleaner)
    

        let bufferingRefs = false

        /**
         * @type { number[] }
         */
        const bufferedRefs = []

        /**
         * 
         * @param {number} id 
         */
        function refRemote(id) {
            if (!bufferingRefs) {
                return rpcSendMayThrow(getOwnerAndId(id)[0], {
                    type: "ref",
                    id
                })
            } else {
                bufferedRefs.push(id)
                return {}
            }
        }
        


        /**
         * 
         * @param {(...args:any[])=>void} cb 
         */
        function batchRef(cb) {
            if (bufferingRefs) {
                cb()
            } else {
                bufferingRefs = true
                try {
                    cb()
                } finally {
                    // a throwing callback must not leave every later call buffered
                    bufferingRefs = false
                }
                
                // handle batching here
                const ids = bufferedRefs.slice(0)
                bufferedRefs.length = 0

                /**
                 * @type {Map<number, number[]>}
                 */
                const mapByTarget = new Map()

                for (let id of ids) {
                    const [owner] = getOwnerAndId(id)
                    const list = mapByTarget.get(owner) || []
                    list.push(id)

                    if (!mapByTarget.has(owner)) {
                        mapByTarget.set(owner, list)
                    }
                }

                for (let entry of mapByTarget) {
                    rpcSendMayThrow(entry[0], {
                        type: "ref-many",
                        ids: entry[1]
                    })
                }
            }
        }

        
        let bufferingUnrefs = false

        /**
         * @type { number[] }
         */
        const bufferedUnrefs = []
        /**
        * 
        * @param {number} id 
        */
        function unrefRemote(id) {
            if (!bufferingUnrefs) {
                return rpcSend(getOwnerAndId(id)[0], {
                    type: 'unref',
                    id
                })
            } else {
                bufferedUnrefs.push(id)
                return {}
            }
        }

        
        /**
         * 
         * @param {(...args:any[])=>void} cb 
         */
        function batchUnref(cb) {
            if (bufferingUnrefs) {
                cb()
            } else {
                bufferingUnrefs = true
                try {
                    cb()
                } finally {
                    // a throwing callback must not leave every later call buffered
                    bufferingUnrefs = false
                }
                
                // handle batching here
                const ids = bufferedUnrefs.slice(0)
                bufferedUnrefs.length = 0

                /**
                 * @type {Map<number, number[]>}
                 */
                const mapByTarget = new Map()

                for (let id of ids) {
                    const [owner] = getOwnerAndId(id)
                    const list = mapByTarget.get(owner) || []
                    list.push(id)

                    if (!mapByTarget.has(owner)) {
                        mapByTarget.set(owner, list)
                    }
                }

                for (let entry of mapByTarget) {
                    rpcSendMayThrow(entry[0], {
                        type: "unref-many",
                        ids: entry[1]
                    })
                }
            }
        }

        /**
         * descriptors fetched together with the keys by the last ownKeys,
         * so Object.keys and friends don't need a request per property
         * @type { { id: number, map: Map<string | symbol, PropertyDescriptor> } | null }
         */
        let preloadedDescriptors = null

        /**
         * well-known symbols are the same in every thread, so they can be sent by name
         * @type {Map<symbol, string>}
         */
        const wellKnownSymbols = new Map(
            Object.getOwnPropertyNames(Symbol)
                .filter(name => typeof (/** @type {any} */ (Symbol))[name] === 'symbol')
                .map(name => [(/** @type {any} */ (Symbol))[name], name])
        )

        /**
         * @param {symbol} symbol
         * @returns {ValueSymbol | null} null for a unique symbol, those can't be mapped between threads yet
         */
        function encodeSymbol(symbol) {
            const name = wellKnownSymbols.get(symbol)
            if (name !== undefined) {
                return { type: 'symbol', wellKnown: name }
            }

            const key = Symbol.keyFor(symbol)
            if (key !== undefined) {
                return { type: 'symbol', key }
            }

            return null
        }

        /**
         * @param {ValueSymbol} value
         * @returns {symbol}
         */
        function decodeSymbol(value) {
            if (value.wellKnown !== undefined) {
                const symbol = (/** @type {any} */ (Symbol))[value.wellKnown]
                if (typeof symbol !== 'symbol') {
                    throw new TypeError('Symbol.' + value.wellKnown + ' is not supported in this thread')
                }
                return symbol
            }

            return Symbol.for(/** @type {string} */ (value.key))
        }

        /**
         * @param {string | symbol} key
         * @returns {Key | null} null for a unique symbol
         */
        function encodeKey(key) {
            return typeof key === 'string' ? key : encodeSymbol(key)
        }

        /**
         * @param {Key} key
         * @returns {string | symbol}
         */
        function decodeKey(key) {
            return typeof key === 'string' ? key : decodeSymbol(key)
        }

        /**
         * @param {string | symbol} key
         */
        function uniqueSymbolError(key) {
            return new TypeError('can\'t use a unique symbol on an object of another thread: ' + String(key))
        }

        /**
         * get object from object id
         * @param {number} id 
         * @param {null |"function"|"object"} type
         * @returns {any}
         */
        function getObjectFromId(id, type = "object") {
            if (isRemoteId(id)) {
                const ref = remoteIdToObject.get(id)
                const existing = ref && ref.deref()
                if (existing === undefined) {
                    if (type === null) {
                        throw new Error('unknown id')
                    }
    
                    // a bound function has no own `prototype`, which would be non-configurable
                    // and make ownKeys fail for remote functions that don't have one either
                    const proto = type === 'function' ? function PlaceHolder () {}.bind(null) : {}
                    const owner = getOwnerAndId(id)[0]
    
                    refRemote(id)
    
                    const proxy = new Proxy(proto, {
                        get(target, p, receiver) {
                            preloadedDescriptors = null
                            const key = encodeKey(p)
                            // the remote object can't have a key that never left this thread
                            if (key === null) return undefined

                            return convertToRaw(rpcSendMayThrow(owner, /** @type {CommandPropertyGet} */({
                                type: 'get',
                                id: id,
                                property: key
                            })).value)
                        },
                        set(target, p, value, receiver) {
                            preloadedDescriptors = null
                            const key = encodeKey(p)
                            if (key === null) throw uniqueSymbolError(p)

                            return rpcSendMayThrow(owner, /** @type {CommandPropertySet} */({
                                type: 'set',
                                id: id,
                                property: key,
                                value: convertToWrapped(value)
                            })).success
                        },
                        has(target, p) {
                            preloadedDescriptors = null
                            const key = encodeKey(p)
                            if (key === null) return false

                            return rpcSendMayThrow(owner, /** @type {CommandHas} */({
                                type: 'has',
                                id,
                                property: key
                            })).result
                        },
                        deleteProperty(target, p) {
                            preloadedDescriptors = null
                            const key = encodeKey(p)
                            if (key === null) return true

                            return rpcSendMayThrow(owner, /** @type {CommandDelete} */({
                                type: 'delete',
                                id,
                                property: key
                            })).result
                        },
                        defineProperty(target, p, descriptor) {
                            preloadedDescriptors = null
                            const key = encodeKey(p)
                            if (key === null) throw uniqueSymbolError(p)

                            return rpcSendMayThrow(owner, /** @type {CommandDefineProperty} */({
                                type: 'defineProperty',
                                id,
                                property: key,
                                descriptor: mapDescriptor(descriptor)
                            })).result
                        },
                        ownKeys(target) {
                            preloadedDescriptors = null
                            var res = rpcSendMayThrow(owner, /** @type {CommandProperties} */({
                                type: 'getProperties',
                                id
                            }))

                            const keys = res.properties.map(decodeKey)

                            batchRef(() => {
                                /**
                                 * @type { Map<string | symbol, PropertyDescriptor> }
                                 */
                                const map = new Map()

                                keys.forEach((key, index) => {
                                    map.set(key, unmapDescriptor(res.preloadDescriptor[index]))
                                })

                                preloadedDescriptors = { id, map }
                            })

                            return keys
                        },
                        getOwnPropertyDescriptor(target, p) {
                            if (preloadedDescriptors && preloadedDescriptors.id === id && preloadedDescriptors.map.has(p)) {
                                return preloadedDescriptors.map.get(p)
                            }

                            preloadedDescriptors = null
                            const key = encodeKey(p)
                            if (key === null) return undefined

                            const res = rpcSendMayThrow(owner, /** @type {CommandPropertyGetDescriptor} */({
                                type: "getDescriptor",
                                id,
                                property: key
                            })).descriptor

                            return res === null ? undefined : unmapDescriptor(res)
                        },
                        construct(target, argArray, newTarget) {
                            preloadedDescriptors = null
                            return convertToRaw(rpcSendMayThrow(owner, /** @type {CommandConstruct} */({
                                type: "construct",
                                self: convertToWrapped(newTarget),
                                args: argArray.map(convertToWrapped),
                                fn: /** @type { ValueObject|ValueFunction } */({
                                    type,
                                    ref: id
                                })
                            })).value)
                        },
                        apply(target, thisArg, argArray) {
                            preloadedDescriptors = null
                            return convertToRaw(rpcSendMayThrow(owner, /** @type {CommandCall} */({
                                type: "call",
                                self: convertToWrapped(thisArg),
                                args: argArray.map(convertToWrapped),
                                fn: /** @type { ValueObject|ValueFunction } */({
                                    type,
                                    ref: id
                                })
                            })).value)
                        }
                    })
                    
                    remoteIdToObject.set(id, new WeakRef(proxy))
                    remoteObjectToId.set(proxy, id)
                    cleaner.register(proxy, id)
                    return proxy
                }

                return existing
            } else {
                return selfIdToItem.get(id)
            }
        }
    
        /**
         * get object id from object
         * @param {any} obj 
         * @returns {number}
         */
        function getIdFromObject(obj) {
            if (isRemote(obj)) {
                const id = remoteObjectToId.get(obj)
                if (id == null) {
                    throw new Error("BUG: unmapped remote object " + obj)
                }
                return id
            } else {
                if (selfItemToId.has(obj)) {
                    return /** @type {number} */(selfItemToId.get(obj))
                }
    
                const newId = currentObjectId++
                const merged = getMergedId(currentThread, newId)
                if (typeof obj !== 'function' && typeof obj !== 'object') debugger
                selfIdToItem.set(merged, obj)
                selfItemToId.set(obj, merged)
                selfRefs.set(obj, 0)
                return merged
            }
        }
    
        /**
         * 
         * @param {any} arg 
         * @returns {Value}
         */
        function convertToWrapped(arg) {
            // null and undefined
            if (arg == null) {
                return {
                    type: "primitive",
                    value: arg
                }
            }
            switch (typeof arg) {
                case "boolean":
                case "string":
                    return {
                        type: "primitive",
                        value: arg
                    }
                case "number":
                    // JSON turns NaN and Infinity into null and drops the sign of -0
                    if (Number.isFinite(arg) && !Object.is(arg, -0)) {
                        return {
                            type: "primitive",
                            value: arg
                        }
                    }
                    return {
                        type: "number",
                        value: Object.is(arg, -0) ? '-0' : String(arg)
                    }
                case "bigint":
                    return {
                        type: "bigint",
                        value: arg.toString()
                    }
                case "symbol":
                    const symbol = encodeSymbol(arg)
                    if (symbol === null) {
                        throw new TypeError('can\'t pass a unique symbol to another thread: ' + String(arg))
                    }
                    return symbol
                case "object":
                    return {
                        type: "object",
                        ref: getIdFromObject(arg)
                    }
                case "function":
                    return {
                        type: "function",
                        ref: getIdFromObject(arg)
                    }
            }
            throw new Error("unimplemented")
        }
    
        /**
         * 
         * @param {Value} arg 
         * @returns {any}
         */
        function convertToRaw(arg) {
            switch (arg.type) {
                case "primitive":
                    return arg.value
                case "number":
                    return arg.value === '-0' ? -0 : Number(arg.value)
                case "bigint":
                    return BigInt(arg.value)
                case "symbol":
                    return decodeSymbol(arg)
                case "object":
                    return getObjectFromId(arg.ref, "object")
                case "function":
                    return getObjectFromId(arg.ref, "function")
            }
            throw new Error("unimplemented")
        }
        
        /**
         * 
         * @param {PropertyDescriptor} des 
         * @returns {mappedDescriptor}
         */
        function mapDescriptor(des) {
            if ('get' in des || 'set' in des) {
                return  {
                    descriptorType: 'accessor',
                    enumerable: des.enumerable,
                    configurable: des.configurable,
                    get: convertToWrapped(des.get),
                    set: convertToWrapped(des.set)
                }
            } else {
                return {
                    descriptorType: 'value',
                    enumerable: des.enumerable,
                    configurable: des.configurable,
                    writable: des.writable,
                    value: convertToWrapped(des.value)
                }
            }
        }
        /**
         * 
         * @param {mappedDescriptor} res 
         * @param {boolean} [exact] keep `configurable`, for defining on a real object
         * @returns {PropertyDescriptor}
         */
        function unmapDescriptor(res, exact = false) {
            if (res.descriptorType === 'accessor') {
                return {
                    enumerable: res.enumerable,
                    // configurable: res.configurable,
                    // because configurable false with unmatched value with placeholder will throw
                    configurable: exact ? res.configurable : true,
                    set: convertToRaw(res.set),
                    get: convertToRaw(res.get)
                }
            } else {
                return {
                    enumerable: res.enumerable,
                    // configurable: res.configurable,
                    // because configurable false with unmatched value with placeholder will throw
                    configurable: exact ? res.configurable : true,
                    writable: res.writable,
                    value: convertToRaw(res.value)
                }
            }
        }

        /**
         * handle remote request
         * @param {number} from 
         * @param {Command} message 
         * @returns {DomProxyResponse}
         */
        function listener(from, message) {
            try {
                switch (message.type) {
                    case "root":
                        return {
                            value: convertToWrapped(getRoot())
                        }
                    case "get":
                        return {
                            value: convertToWrapped(getObjectFromId(message.id)[decodeKey(message.property)])
                        }
                    case "set":
                        return {
                            success: Reflect.set(getObjectFromId(message.id), decodeKey(message.property), convertToRaw(message.value))
                        }
                    case "has":
                        return {
                            result: decodeKey(message.property) in getObjectFromId(message.id)
                        }
                    case "delete":
                        return {
                            result: Reflect.deleteProperty(getObjectFromId(message.id), decodeKey(message.property))
                        }
                    case "defineProperty":
                        return {
                            result: Reflect.defineProperty(
                                getObjectFromId(message.id),
                                decodeKey(message.property),
                                unmapDescriptor(message.descriptor, true)
                            )
                        }
                    case "ref":
                        var object = getObjectFromId(message.id)
                        var old = selfRefs.get(object)
                        selfRefs.set(object, old + 1)
                        return {}
                    case "ref-many":
                        for (let id of message.ids) {
                            var object = getObjectFromId(id)
                            var old = selfRefs.get(object)
                            selfRefs.set(object, old + 1)
                        }

                        return {}
                    case "unref":
                        var object = getObjectFromId(message.id)
                        var old = selfRefs.get(object)
                        var newValue = old - 1
                        if (newValue === 0) {
                            selfRefs.delete(object)
                            selfIdToItem.delete(message.id)
                            selfItemToId.delete(object)
                        } else {
                            selfRefs.set(object, newValue)
                        }
                        return {}
                    case "unref-many":
                        for (let id of message.ids) {
                            var object = getObjectFromId(id)
                            var old = selfRefs.get(object)
                            var newValue = old - 1
                            if (newValue === 0) {
                                selfRefs.delete(object)
                                selfIdToItem.delete(id)
                                selfItemToId.delete(object)
                            } else {
                                selfRefs.set(object, newValue)
                            }
                        }
                        return {}
                    case "getDescriptor":
                        var object = getObjectFromId(message.id)
                        var des = Object.getOwnPropertyDescriptor(object, decodeKey(message.property))
                        return {
                            descriptor: des ? mapDescriptor(des) : null
                        }
                    case "getProperties":
                        var object = getObjectFromId(message.id)
                        var keys = Reflect.ownKeys(object)
                            .map(key => /** @type {[string | symbol, Key | null]} */ ([key, encodeKey(key)]))
                            // unique symbols can't be mapped, leave them out
                            .filter(pair => pair[1] !== null)
                        return {
                            properties: keys.map(pair => /** @type {Key} */ (pair[1])),
                            preloadDescriptor: keys.map(pair => mapDescriptor(
                                /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(object, pair[0]))
                            ))
                        }
                    case "construct":
                        var fn = convertToRaw(message.fn)
                        var self = convertToRaw(message.self)
                        var args = message.args.map(convertToRaw)
                        return {
                            value: convertToWrapped(Reflect.construct(fn, args, self))
                        }
                    case "call":
                        var fn = convertToRaw(message.fn)
                        var self = convertToRaw(message.self)
                        var args = message.args.map(convertToRaw)
                        return {
                            value: convertToWrapped(Reflect.apply(fn, self, args))
                        }
                }
            } catch (err) {
                console.error(err)
                debugger
                return {
                    error: convertToWrapped(err)
                }
            }
    
            return {
                error: convertToWrapped(new Error("not implemented method " + /** @type { any } */(message).type))
            }
        }
    
        /**
         * get remote root
         * @param {number} target 
         */
        function getRemoteRoot(target) {
            return convertToRaw(rpcSendMayThrow(target, {
                type: 'root'
            }).value)
        }
        
        return {
            current: rpc.current,
            getRemote: getRemoteRoot
        }
    },
    // keeps the registries alive, a collected registry never calls back
    __finalizationRegistries: /** @type { FinalizationRegistry<number>[] } */([])
}