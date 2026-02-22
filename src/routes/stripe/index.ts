import { Hono } from 'hono'
import type { Env } from '../../types'

const stripeRouter = new Hono<{ Bindings: Env }>()

// Routes for /api/v1/stripe/* will be defined here
// POST /webhook

export default stripeRouter
