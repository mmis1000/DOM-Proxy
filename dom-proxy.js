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
         * whether the engine can hold unique symbols weakly (ES2023),
         * otherwise symbols that crossed threads are kept forever
         */
        const weakSymbols = (() => {
            try {
                new WeakMap().set(/** @type {any} */ (Symbol()), 0)
                new WeakRef(/** @type {any} */ (Symbol()))
                new FinalizationRegistry(() => { }).register(/** @type {any} */ (Symbol()), 0)
                return true
            } catch (err) {
                return false
            }
        })()

        /**
         * a WeakMap that also takes unique symbols, holding them strongly where the engine can't hold them weakly
         */
        class IdMap {
            constructor() {
                /** @type {WeakMap<any, number>} */
                this.weak = new WeakMap()
                /** @type {Map<any, number>} */
                this.strong = new Map()
            }
            /** @param {any} key */
            store(key) {
                return typeof key === 'symbol' && !weakSymbols ? this.strong : this.weak
            }
            /** @param {any} key */
            get(key) {
                return this.store(key).get(key)
            }
            /** @param {any} key */
            has(key) {
                return this.store(key).has(key)
            }
            /**
             * @param {any} key
             * @param {number} value
             */
            set(key, value) {
                this.store(key).set(key, value)
            }
            /** @param {any} key */
            delete(key) {
                this.store(key).delete(key)
            }
        }
    
        /**
         * how many proxies other threads hold for each of our ids
         * @type {Map<number, number>}
         */
        const selfRefs = new Map()
    
        /**
         * @type {Map<number, any>}
         */
        const selfIdToItem = new Map()
    
        const selfItemToId = new IdMap()
    
        const remoteObjectToId = new IdMap()
    
        /**
         * a WeakRef, or a strong stand-in for symbols where those can't be held weakly
         * @type {Map<number, { deref(): any }>}
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
         * @returns {ValueSymbol}
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

            // a unique symbol gets an id like an object, the other side makes one stand-in symbol per id
            return { type: 'symbol', ref: getIdFromObject(symbol), description: symbol.description }
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

            if (value.ref !== undefined) {
                return getObjectFromId(value.ref, 'symbol', value.description)
            }

            return Symbol.for(/** @type {string} */ (value.key))
        }

        /**
         * @param {string | symbol} key
         * @returns {Key}
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
         * Proxy invariant: a property that is non-configurable on the placeholder target (the `length` of an array)
         * must be reported non-configurable, and once the real one is read-only, the target's must be read-only
         * with the same value too.
         * @param {any} target
         * @param {string | symbol} key
         * @param {PropertyDescriptor} descriptor
         */
        function fitToTarget(target, key, descriptor) {
            const own = Reflect.getOwnPropertyDescriptor(target, key)

            if (!own || own.configurable) {
                return descriptor
            }

            descriptor.configurable = false

            if (own.writable && descriptor.writable === false) {
                Object.defineProperty(target, key, { value: descriptor.value, writable: false })
            }

            return descriptor
        }

        /**
         * remember a proxy or stand-in symbol made for a remote id
         * @param {number} id
         * @param {any} item
         */
        function rememberRemote(id, item) {
            if (typeof item === 'symbol' && !weakSymbols) {
                remoteIdToObject.set(id, { deref: () => item })
            } else {
                remoteIdToObject.set(id, new WeakRef(item))
                cleaner.register(item, id)
            }
            remoteObjectToId.set(item, id)
        }

        /**
         * get object from object id
         * @param {number} id 
         * @param {null |"function"|"object"|"array"|"symbol"} type
         * @param {string} [description] of a symbol
         * @returns {any}
         */
        function getObjectFromId(id, type = "object", description) {
            if (isRemoteId(id)) {
                const ref = remoteIdToObject.get(id)
                const existing = ref && ref.deref()
                if (existing === undefined) {
                    if (type === null) {
                        throw new Error('unknown id')
                    }

                    refRemote(id)

                    if (type === 'symbol') {
                        const symbol = Symbol(description)
                        rememberRemote(id, symbol)
                        return symbol
                    }
    
                    // a bound function has no own `prototype`, which would be non-configurable
                    // and make ownKeys fail for remote functions that don't have one either.
                    // Array.isArray looks at the target, so arrays get an array.
                    const proto = type === 'function' ? function PlaceHolder () {}.bind(null) : type === 'array' ? [] : {}
                    const owner = getOwnerAndId(id)[0]
    
                    const proxy = new Proxy(proto, {
                        get(target, p, receiver) {
                            preloadedDescriptors = null
                            const key = encodeKey(p)

                            return convertToRaw(rpcSendMayThrow(owner, /** @type {CommandPropertyGet} */({
                                type: 'get',
                                id: id,
                                property: key
                            })).value)
                        },
                        set(target, p, value, receiver) {
                            preloadedDescriptors = null
                            const key = encodeKey(p)

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

                            return rpcSendMayThrow(owner, /** @type {CommandHas} */({
                                type: 'has',
                                id,
                                property: key
                            })).result
                        },
                        deleteProperty(target, p) {
                            preloadedDescriptors = null
                            const key = encodeKey(p)

                            return rpcSendMayThrow(owner, /** @type {CommandDelete} */({
                                type: 'delete',
                                id,
                                property: key
                            })).result
                        },
                        defineProperty(target, p, descriptor) {
                            preloadedDescriptors = null
                            const key = encodeKey(p)

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
                                    map.set(key, fitToTarget(target, key, unmapDescriptor(res.preloadDescriptor[index])))
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

                            const res = rpcSendMayThrow(owner, /** @type {CommandPropertyGetDescriptor} */({
                                type: "getDescriptor",
                                id,
                                property: key
                            })).descriptor

                            return res === null ? undefined : fitToTarget(target, p, unmapDescriptor(res))
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
                    
                    rememberRemote(id, proxy)
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
                selfIdToItem.set(merged, obj)
                selfItemToId.set(obj, merged)
                selfRefs.set(merged, 0)
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
                    return encodeSymbol(arg)
                case "object":
                    /** @type {ValueObject} */
                    const value = {
                        type: "object",
                        ref: getIdFromObject(arg)
                    }
                    // the other side needs an array placeholder for Array.isArray
                    if (Array.isArray(arg)) value.array = true
                    return value
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
                    return getObjectFromId(arg.ref, arg.array ? "array" : "object")
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
         * another thread made or dropped proxies for one of our ids,
         * once none is left the id is forgotten
         * @param {number} id
         * @param {number} change
         */
        function changeRefs(id, change) {
            if (!selfIdToItem.has(id)) return

            const count = (selfRefs.get(id) || 0) + change

            if (count <= 0) {
                selfItemToId.delete(selfIdToItem.get(id))
                selfIdToItem.delete(id)
                selfRefs.delete(id)
            } else {
                selfRefs.set(id, count)
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
                        changeRefs(message.id, 1)
                        return {}
                    case "ref-many":
                        for (let id of message.ids) {
                            changeRefs(id, 1)
                        }
                        return {}
                    case "unref":
                        changeRefs(message.id, -1)
                        return {}
                    case "unref-many":
                        for (let id of message.ids) {
                            changeRefs(id, -1)
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
                        return {
                            properties: keys.map(encodeKey),
                            preloadDescriptor: keys.map(key => mapDescriptor(
                                /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(object, key))
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