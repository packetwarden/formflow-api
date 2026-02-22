import { Hono } from 'hono'
import type { Env } from '../../types'

const runnerRouter = new Hono<{ Bindings: Env }>()

// Routes for /api/v1/f/* will be defined here
// GET /:formId/schema, POST /:formId/submit

export default runnerRouter
