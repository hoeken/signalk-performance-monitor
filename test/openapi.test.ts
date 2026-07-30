/**
 * Keeps openApi.json honest: the documented paths and methods must match the
 * routes actually registered, every $ref must resolve to a component, and the
 * server URL must match the router mount point derived from the plugin id.
 */
import express from 'express'
import { describe, expect, it } from 'vitest'
import openApi from '../src/openApi.json'
import { PLUGIN_ID } from '../src/plugin'
import { registerRoutes } from '../src/routes'

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> }
}

function registeredRoutes(): string[] {
  const router = express.Router()
  registerRoutes(router, () => null, { error: () => {} })
  const stack = (router as unknown as { stack: RouteLayer[] }).stack
  const routes: string[] = []
  for (const layer of stack) {
    if (!layer.route) continue
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (enabled) routes.push(`${method.toUpperCase()} ${layer.route.path}`)
    }
  }
  return routes.sort()
}

function documentedRoutes(): string[] {
  const routes: string[] = []
  for (const [path, operations] of Object.entries(openApi.paths)) {
    const expressPath = path.replace(/\{([^}]+)\}/g, ':$1')
    for (const method of Object.keys(operations)) {
      if (HTTP_METHODS.includes(method)) {
        routes.push(`${method.toUpperCase()} ${expressPath}`)
      }
    }
  }
  return routes.sort()
}

function collectRefs(node: unknown, refs: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, refs)
    return
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') refs.add(value)
      else collectRefs(value, refs)
    }
  }
}

describe('openApi.json', () => {
  it('documents exactly the registered routes', () => {
    expect(documentedRoutes()).toEqual(registeredRoutes())
  })

  it('declares the plugin router mount point as its server', () => {
    expect(openApi.servers).toEqual([{ url: `/plugins/${PLUGIN_ID}` }])
  })

  it('has no dangling $refs', () => {
    const refs = new Set<string>()
    collectRefs(openApi, refs)
    const components = openApi.components as Record<string, Record<string, unknown>>
    expect(refs.size).toBeGreaterThan(0)
    for (const ref of refs) {
      const match = /^#\/components\/([^/]+)\/([^/]+)$/.exec(ref)
      expect(match, `unexpected $ref format: ${ref}`).toBeTruthy()
      const [, section, name] = match as unknown as [string, string, string]
      expect(components[section]?.[name], `dangling $ref: ${ref}`).toBeDefined()
    }
  })

  it('gives every operation a summary and responses', () => {
    for (const [path, operations] of Object.entries(openApi.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (!HTTP_METHODS.includes(method)) continue
        const op = operation as { summary?: string; responses?: object }
        expect(op.summary, `${method.toUpperCase()} ${path} has no summary`).toBeTruthy()
        expect(
          Object.keys(op.responses ?? {}).length,
          `${method.toUpperCase()} ${path} has no responses`,
        ).toBeGreaterThan(0)
      }
    }
  })
})
