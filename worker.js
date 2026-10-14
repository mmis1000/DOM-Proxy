// Worker A: builds the demo UI in the page, as if it ran there
importScripts('./await-async.js', './rpc.js', './dom-proxy.js')

self.onmessage = event => {
    const { ia32, host } = event.data
    const proxy = DomProxy.create(ia32, () => self, { deadAfter: 1000 })

    // the page's window and document, every access below is a synchronous call into the page
    const window = proxy.getRemote(host)
    const document = window.document
    const log = text => window.demoLog('worker A: ' + text)

    /**
     * create an element in the page
     * @param {string} tag
     * @param {object} [props]
     * @param {...any} children
     */
    function h(tag, props = {}, ...children) {
        const element = document.createElement(tag)
        Object.assign(element, props)
        element.append(...children)
        return element
    }

    function counter() {
        let count = 0
        const value = h('output', { id: 'counter-value', textContent: '0' })
        const plus = h('button', { id: 'counter-plus', textContent: '+1' })

        // the listener lives in this worker, the page calls it on every click
        plus.addEventListener('click', () => {
            count++
            value.textContent = String(count)
        })

        return h('section', {}, h('h3', { textContent: 'Counter' }), h('div', { className: 'row' }, plus, value))
    }

    function todo() {
        const input = h('input', { id: 'todo-input', placeholder: 'Something to do' })
        const add = h('button', { id: 'todo-add', textContent: 'Add' })
        const list = h('ul', { id: 'todo-list' })

        function addItem() {
            // reading the input is synchronous too
            const text = input.value.trim()
            if (!text) return
            list.append(h('li', { textContent: text }))
            input.value = ''
            log(`added "${text}"`)
        }

        add.addEventListener('click', addItem)
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') addItem()
        })

        return h('section', {}, h('h3', { textContent: 'Todo list' }), h('div', { className: 'row' }, input, add), list)
    }

    /** @param {(limit: number) => number} countPrimes a function of worker B */
    function primes(countPrimes) {
        const input = h('input', { id: 'primes-input', type: 'number', value: '1000000', min: '2' })
        const run = h('button', { id: 'primes-run', textContent: 'Count primes in worker B' })
        const result = h('output', { id: 'primes-result' })

        run.addEventListener('click', () => {
            const limit = Number(input.value)
            result.textContent = 'counting…'

            // The page waits for this listener like for any listener, so hand the slow part
            // over to a task of our own and let the page go on.
            setTimeout(() => {
                const start = performance.now()
                try {
                    const count = countPrimes(limit)
                    const ms = Math.round(performance.now() - start)
                    result.className = ''
                    result.textContent = `${count.toLocaleString('en')} primes below ${limit.toLocaleString('en')} (${ms} ms)`
                } catch (err) {
                    result.className = 'error'
                    result.textContent = `${err.name}: ${err.message}`
                    log(`${err.name}: ${err.message}`)
                }
            }, 0)
        })

        return h('section', {},
            h('h3', { textContent: 'Worker to worker' }),
            h('div', { className: 'row' }, input, run),
            h('p', {}, result))
    }

    function facts() {
        const data = window.demoData
        const rows = [
            ['page URL', window.location.href],
            ['document.title', document.title],
            ['window.document === document', String(window.document === document)],
            ['Array.isArray(data.items)', String(Array.isArray(data.items))],
            ['[...data.items]', [...data.items].join(', ')],
            ['`${data.createdAt}`', `${data.createdAt}`],
            ['Object.keys(document.body.dataset)', JSON.stringify(Object.keys(document.body.dataset))],
        ]

        return h('section', {},
            h('h3', { textContent: 'Read from this worker' }),
            h('dl', {}, ...rows.flatMap(([name, value]) => [h('dt', { textContent: name }), h('dd', { textContent: value })])))
    }

    // called by the page once both workers are up
    self.start = countPrimes => {
        const app = document.getElementById('app')
        app.replaceChildren(counter(), todo(), primes(countPrimes), facts())
        log('built the UI')
    }

    self.postMessage({ ready: proxy.current })
}
