import { createPlugin } from './plugin'

// Signal K server expects `module.exports` to be the plugin factory.
export = createPlugin
