declare class WeakReference<T> {
    get(): T|undefined
}

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

type Value = ValuePrimitive | ValueObject | ValueFunction

interface CommandGetRoot {
    type: 'root'
}

interface CommandRef {
    type: 'ref'
    id: number
}

interface CommandUnref {
    type: 'unref'
    id: number
}

interface CommandPropertyGet {
    type: 'get'
    id: number
    property: string
}

interface CommandPropertySet {
    type: 'set'
    id: number
    property: string
    value: Value
}

interface CommandPropertyGetDescriptor {
    type: 'getDescriptor'
    id: number
    property: string
}

interface CommandProperties {
    type: 'getProperties'
    id: number
}

type Command = 
    CommandGetRoot |
    CommandRef |
    CommandUnref |
    CommandPropertyGet |
    CommandPropertySet |
    CommandPropertyGetDescriptor |
    CommandProperties

interface ResponseGetRoot {
    id: number
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

interface ResponsePropertyGetDescriptor {
    descriptor: PropertyDescriptor
}

interface ResponseProperties {
    properties: string[]
}
interface ResponseError {
    error: Value
}

type DomProxyResponse = 
    ResponseGetRoot |
    ResponseRef |
    ResponseUnref |
    ResponsePropertyGet |
    ResponsePropertySet |
    ResponsePropertyGetDescriptor |
    ResponseProperties

interface RpcSend {
    (target: number, command: CommandGetRoot): ResponseGetRoot | ResponseError
    (target: number, command: CommandRef): ResponseRef | ResponseError
    (target: number, command: CommandUnref): ResponseUnref | ResponseError
    (target: number, command: CommandPropertyGet): ResponsePropertyGet | ResponseError
    (target: number, command: CommandPropertySet): ResponsePropertySet | ResponseError
    (target: number, command: CommandPropertyGetDescriptor): ResponsePropertyGetDescriptor | ResponseError
    (target: number, command: CommandProperties): ResponseProperties | ResponseError
}

declare function setImmediate(fn: (...arg: any[])=>void): number
declare function clearImmediate(id: number): void
