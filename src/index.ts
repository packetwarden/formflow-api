import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'

import type { Env } from './types'
import authRouter from './routes/auth'
import buildRouter from './routes/build'
import runnerRouter from './routes/f'
import stripeRouter from './routes/stripe'

const app = new Hono<{ Bindings: Env }>()

app.use('*', logger())
app.use('*', cors())

// API Routing Strategy
app.route('/api/v1/auth', authRouter)
app.route('/api/v1/build', buildRouter)
app.route('/api/v1/f', runnerRouter)
app.route('/api/v1/stripe', stripeRouter)

app.get('/', (c) => {
    return c.text('FormSandbox (FormFlow) API Edge Runtime')
})

export default app
