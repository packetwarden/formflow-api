import { Hono } from 'hono'
import type { Env } from '../../types'

const buildRouter = new Hono<{ Bindings: Env }>()

// Routes for /api/v1/build/:workspaceId/* will be defined here
// GET /forms, GET /forms/:formId, PUT /forms/:formId, POST /forms/:formId/publish

export default buildRouter
