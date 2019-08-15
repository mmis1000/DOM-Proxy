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
    */   
    create: function create(ia32, getRoot) {
        const rpc = listen(listener, ia32)
    
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
         * @type {FinalizationGroup<any, any, number>}
         */
        const cleaner = new FinalizationGroup(iter => {
            batchUnref(() => {
                for (let id of iter) {
                    remoteIdToObject.delete(id)
                    unrefRemote(id)
                }
            })
        })
        
        DomProxy.__finalizationGroups.push(cleaner)
    

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
                cb()
                bufferingRefs = false
                
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
                    return rpcSendMayThrow(entry[0], {
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
                cb()
                bufferingUnrefs = false
                
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
                    return rpcSendMayThrow(entry[0], {
                        type: "unref-many",
                        ids: entry[1]
                    })
                }
            }
        }

        /**
         * @type { PropertyDescriptorMap | null }
         */
        let preloadedDescriptors = null

        /**
         * get object from object id
         * @param {number} id 
         * @param {null |"function"|"object"} type
         * @returns {any}
         */
        function getObjectFromId(id, type = "object") {
            if (isRemoteId(id)) {
                const ref = remoteIdToObject.get(id)
                if (!ref) {
                    if (type === null) {
                        throw new Error('unknown id')
                    }
    
                    const proto = type === 'function' ? function PlaceHolder () {} : {}
    
                    refRemote(id)
    
                    const proxy = new Proxy(proto, {
                        get(target, p, receiver) {
                            preloadedDescriptors = null
                            if (typeof p === 'symbol') {
                                throw new Error('not support')
                            }
    
                            return convertToRaw(rpcSendMayThrow(getOwnerAndId(id)[0], /** @type {CommandPropertyGet} */({
                                type: 'get',
                                id: id,
                                property: p
                            })).value)
                        },
                        set(target, p, value, receiver) {
                            preloadedDescriptors = null
                            if (typeof p === 'symbol') {
                                throw new Error('not support')
                            }
    
                            return rpcSendMayThrow(getOwnerAndId(id)[0], /** @type {CommandPropertySet} */({
                                type: 'set',
                                id: id,
                                property: p,
                                value: convertToWrapped(value)
                            })).success
                        },
                        ownKeys(target) {
                            preloadedDescriptors = null
                            var res = rpcSendMayThrow(getOwnerAndId(id)[0], {
                                type: 'getProperties',
                                id
                            })

                            batchRef(() => {
                                /**
                                 * @type { PropertyDescriptorMap }
                                 */
                                const map = {}

                                for (let key of Object.keys(res.preloadDescriptor)) {
                                    map[key] = unmapDescriptor(res.preloadDescriptor[key])
                                }

                                preloadedDescriptors = map
                            })

                            return res.properties
                        },
                        getOwnPropertyDescriptor(target, p) {
                            if (typeof p !== 'string') throw new Error()

                            if (preloadedDescriptors && preloadedDescriptors[p]) {
                                return preloadedDescriptors[p]
                            }

                            const res = rpcSendMayThrow(getOwnerAndId(id)[0], /** @type {CommandPropertyGetDescriptor} */({
                                type: "getDescriptor",
                                id,
                                property: p
                            })).descriptor

                            return unmapDescriptor(res)
                        },
                        construct(target, argArray, newTarget) {
                            preloadedDescriptors = null
                            return convertToRaw(rpcSendMayThrow(getOwnerAndId(id)[0], /** @type {CommandConstruct} */({
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
                            return convertToRaw(rpcSendMayThrow(getOwnerAndId(id)[0], /** @type {CommandCall} */({
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
                    cleaner.register(proxy, id, proxy)
                    return proxy
                }

                return ref.deref()
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
                case "number":
                    return {
                        type: "primitive",
                        value: arg
                    }
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
            if (des.get != null) {
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
         * @returns {PropertyDescriptor}
         */
        function unmapDescriptor(res) {
            if (res.descriptorType === 'accessor') {
                return {
                    enumerable: res.enumerable,
                    // configurable: res.configurable,
                    // because configurable false with unmatched value with placeholder will throw
                    configurable: true,
                    set: convertToRaw(res.set),
                    get: convertToRaw(res.get)
                }
            } else {
                return {
                    enumerable: res.enumerable,
                    // configurable: res.configurable,
                    // because configurable false with unmatched value with placeholder will throw
                    configurable: true,
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
                            value: convertToWrapped(getObjectFromId(message.id)[message.property])
                        }
                    case "set":
                        getObjectFromId(message.id)[message.property] = convertToRaw(message.value)
    
                        return {
                            success: true
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
                        var des = Object.getOwnPropertyDescriptor(object, message.property)
                        if (!des) throw "unknown property " + message.property
                        if (des.get != null) {
                            return {
                                descriptor: {
                                    descriptorType: 'accessor',
                                    enumerable: des.enumerable,
                                    configurable: des.configurable,
                                    get: convertToWrapped(des.get),
                                    set: convertToWrapped(des.set)
                                }
                            }
                        } else {
                            return {
                                descriptor: {
                                    descriptorType: 'value',
                                    enumerable: des.enumerable,
                                    configurable: des.configurable,
                                    writable: des.writable,
                                    value: convertToWrapped(des.value)
                                }
                            }
                        }
                    case "getProperties":
                        var object = getObjectFromId(message.id)
                        var keys = /** @type {string[]} */(Reflect.ownKeys(object).filter(i => typeof i === 'string'))
                        var descriptors = Object.getOwnPropertyDescriptors(object)
                        return {
                            properties: keys,
                            preloadDescriptor: keys.map(i => /** @type {[String, mappedDescriptor]} */([i, mapDescriptor(descriptors[i])])).reduce((prev, curr) => {
                                prev[curr[0]] = curr[1]
                                return prev
                            }, /** @type {{[key: string]: mappedDescriptor}} */({}))
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
                error: "not implemented method " + /** @type { any } */(message).type
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
    __finalizationGroups: /** @type { FinalizationGroup<any, any, number>[] } */([])
}