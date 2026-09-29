import { type Instance, render } from 'ink'
import { createElement } from 'react'
import type { ProviderId } from '../models/registry.js'
import { FirstRunSetup, type SetupResult } from './setup.js'

/** Run the first-run wizard in the same Ink runtime used by the main TUI. */
export function runFirstRunSetup(initialProvider?: ProviderId): Promise<SetupResult | null> {
  return new Promise((resolve) => {
    let instance: Instance | null = null
    let finished = false
    const finish = (result: SetupResult | null) => {
      if (finished) return
      finished = true
      resolve(result)
      instance?.unmount()
    }
    instance = render(
      createElement(FirstRunSetup, {
        initialProvider,
        onComplete: (result) => finish(result),
        onCancel: () => finish(null),
      }),
      {
        exitOnCtrlC: false,
        patchConsole: true,
        incrementalRendering: true,
        maxFps: 30,
      },
    )
    void instance.waitUntilExit().then(() => finish(null))
  })
}
