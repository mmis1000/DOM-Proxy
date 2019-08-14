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
            for (let id of iter) {
                remoteIdToObject.delete(id)
                rpcSend(getOwnerAndId(id)[0], {
                    type: 'unref',
                    id
                })
            }
        })
        
        DomProxy.__finalizationGroups.push(cleaner)
    
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
    
                    rpcSendMayThrow(getOwnerAndId(id)[0], {
                        type: "ref",
                        id
                    })
    
                    const proxy = new Proxy(proto, {
                        get(target, p, receiver) {
                            p = p.toString()
    
                            return convertToRaw(rpcSendMayThrow(getOwnerAndId(id)[0], /** @type {CommandPropertyGet} */({
                                type: 'get',
                                id: id,
                                property: p
                            })).value)
                        },
                        set(target, p, value, receiver) {
                            p = p.toString()
    
                            return rpcSendMayThrow(getOwnerAndId(id)[0], /** @type {CommandPropertySet} */({
                                type: 'set',
                                id: id,
                                property: p,
                                value: convertToWrapped(value)
                            })).success
                        },
                        ownKeys(target) {
                            return rpcSendMayThrow(getOwnerAndId(id)[0], {
                                type: 'getProperties',
                                id
                            }).properties
                        },
                        getOwnPropertyDescriptor(target, p) {
                            const res = rpcSendMayThrow(getOwnerAndId(id)[0], /** @type {CommandPropertyGetDescriptor} */({
                                type: "getDescriptor",
                                id,
                                property: p
                            })).descriptor

                            return {
                                enumerable: res.enumerable,
                                // configurable: res.configurable,
                                // because configurable false with unmatched value with placeholder will throw
                                configurable: true,
                                writable: res.writable,
                                value: convertToRaw(res.value),
                                set: convertToRaw(res.set),
                                get: convertToRaw(res.get)
                            }
                        }
                    })
                    
                    remoteIdToObject.set(id, new WeakRef(proxy))
                    remoteObjectToId.set(proxy, id)
                    cleaner.register(proxy, id, proxy)
                    return proxy
                }
                return ref.get()
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
            if (arg === null) {
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
                    case "getDescriptor":
                        var object = getObjectFromId(message.id)
                        var des = Object.getOwnPropertyDescriptor(object, message.property)
                        if (!des) throw "unknown property " + message.property
                        return {
                            descriptor: {
                                enumerable: des.enumerable,
                                configurable: des.configurable,
                                writable: des.writable,
                                value: convertToWrapped(des.value),
                                get: convertToWrapped(des.get),
                                set: convertToWrapped(des.set)
                            }
                        }
                    case "getProperties":
                        var object = getObjectFromId(message.id)
                        return {
                            properties: /** @type {string[]} */(Reflect.ownKeys(object).filter(i => typeof i === 'string'))
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