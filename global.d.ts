interface ValuePrimitive {
    type: 'primitive'
    value: null | undefined | boolean | number | string
}
interface ValueObject {
    type: 'object'
    ref: number
}
interface ValueFunction {
    type: 'function'
    ref: number
}

/** numbers JSON can't carry: NaN, Infinity, -Infinity, -0 */
interface ValueNumber {
    type: 'number'
    value: string
}
interface ValueBigInt {
    type: 'bigint'
    value: string
}
/** well-known symbols travel by name, registered ones (Symbol.for) by key */
interface ValueSymbol {
    type: 'symbol'
    wellKnown?: string
    key?: string
}

type Value = ValuePrimitive | ValueNumber | ValueBigInt | ValueSymbol | ValueObject | ValueFunction

/** a property key */
type Key = string | ValueSymbol

interface CommandGetRoot {
    type: 'root'
}

interface CommandRef {
    type: 'ref'
    id: number
}

interface CommandRefMany {
    type: 'ref-many'
    ids: number[]
}

interface CommandUnref {
    type: 'unref'
    id: number
}
interface CommandUnrefMany {
    type: 'unref-many'
    ids: number[]
}

interface CommandPropertyGet {
    type: 'get'
    id: number
    property: Key
}

interface CommandPropertySet {
    type: 'set'
    id: number
    property: Key
    value: Value
}

interface CommandHas {
    type: 'has'
    id: number
    property: Key
}

interface CommandDelete {
    type: 'delete'
    id: number
    property: Key
}

interface CommandDefineProperty {
    type: 'defineProperty'
    id: number
    property: Key
    descriptor: mappedDescriptor
}

interface CommandPropertyGetDescriptor {
    type: 'getDescriptor'
    id: number
    property: Key
}

interface CommandProperties {
    type: 'getProperties'
    id: number
}

interface CommandConstruct {
    type: 'construct'
    fn: Value,
    self: Value,
    args: Value[]
}

interface CommandCall {
    type: 'call'
    fn: Value,
    self: Value,
    args: Value[]
}


type Command = 
    CommandGetRoot |
    CommandRef |
    CommandRefMany |
    CommandUnref |
    CommandUnrefMany |
    CommandPropertyGet |
    CommandPropertySet |
    CommandHas |
    CommandDelete |
    CommandDefineProperty |
    CommandPropertyGetDescriptor |
    CommandProperties |
    CommandConstruct |
    CommandCall

interface ResponseGetRoot {
    value: Value
}

interface ResponseRef {

}

interface ResponseUnref {

}

interface ResponsePropertyGet {
    value: Value
}

interface ResponsePropertySet {
    success: boolean
}

interface mappedDescriptorAcc {
    descriptorType: 'accessor',
    get: Value,
    set: Value,
    configurable: boolean | undefined,
    enumerable: boolean | undefined
}

interface mappedDescriptorVal {
    descriptorType: 'value',
    configurable: boolean | undefined,
    enumerable: boolean | undefined,
    writable: boolean | undefined,
    value: Value
}

type mappedDescriptor = mappedDescriptorAcc | mappedDescriptorVal

interface ResponsePropertyGetDescriptor {
    descriptor: mappedDescriptor | null
}

interface ResponseBoolean {
    result: boolean
}

interface ResponseProperties {
    properties: Key[]
    /** descriptors of `properties`, in the same order */
    preloadDescriptor: mappedDescriptor[]
}

interface ResponseError {
    error: Value
}

interface ResponseConstruct {
    value: Value
}
interface ResponseCall {
    value: Value
}

type DomProxyResponse = 
    ResponseGetRoot |
    ResponseRef |
    ResponseUnref |
    ResponsePropertyGet |
    ResponsePropertySet |
    ResponseBoolean |
    ResponsePropertyGetDescriptor |
    ResponseProperties |
    ResponseConstruct |
    ResponseCall

interface RpcSend {
    (target: number, command: CommandGetRoot): ResponseGetRoot | ResponseError
    (target: number, command: CommandRef): ResponseRef | ResponseError
    (target: number, command: CommandRefMany): ResponseRef | ResponseError
    (target: number, command: CommandUnref): ResponseUnref | ResponseError
    (target: number, command: CommandUnrefMany): ResponseUnref | ResponseError
    (target: number, command: CommandPropertyGet): ResponsePropertyGet | ResponseError
    (target: number, command: CommandPropertySet): ResponsePropertySet | ResponseError
    (target: number, command: CommandHas | CommandDelete | CommandDefineProperty): ResponseBoolean | ResponseError
    (target: number, command: CommandPropertyGetDescriptor): ResponsePropertyGetDescriptor | ResponseError
    (target: number, command: CommandProperties): ResponseProperties | ResponseError
    (target: number, command: CommandConstruct): ResponseConstruct | ResponseError
    (target: number, command: CommandCall): ResponseCall | ResponseError
}

type RpcSendWithThrow = {
    (target: number, command: CommandGetRoot): ResponseGetRoot
    (target: number, command: CommandRef): ResponseRef
    (target: number, command: CommandRefMany): ResponseRef
    (target: number, command: CommandUnref): ResponseUnref
    (target: number, command: CommandUnrefMany): ResponseUnref
    (target: number, command: CommandPropertyGet): ResponsePropertyGet
    (target: number, command: CommandPropertySet): ResponsePropertySet
    (target: number, command: CommandHas | CommandDelete | CommandDefineProperty): ResponseBoolean
    (target: number, command: CommandPropertyGetDescriptor): ResponsePropertyGetDescriptor
    (target: number, command: CommandProperties): ResponseProperties
    (target: number, command: CommandConstruct): ResponseConstruct
    (target: number, command: CommandCall): ResponseCall
}

declare function setImmediate(fn: (...arg: any[])=>void): number
declare function clearImmediate(id: number): void


declare module global {
    interface globalThis {
        DomProxy: any
    }

    namespace globalThis {
        var DomProxy: any
    }
}