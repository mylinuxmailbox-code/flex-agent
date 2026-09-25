import { type Instance, render } from 'ink'
import { createElement } from 'react'
import type { Session } from '../session/session.js'
import { App } from './App.jsx'
import { UIStore } from './store.js'

/**
 * Mount the UI.
 *
 * Render options are deliberate, and each one is a decision that would be easy
 * to get wrong:
 *
 *  - `alternateScreen` stays OFF. Ink's own docs note it does not replay frames
 *    when it restores the primary buffer, which would destroy the user's
 *    scrollback. A conversational agent that eats scrollback is unusable.
 *  - `patchConsole` keeps stray `console.log` from corrupting the frame.
 *  - `incrementalRendering` and `maxFps` keep a fast token stream from
 *    repainting hundreds of times a second.
 *  - `exitOnCtrlC` stays OFF so Ctrl+C reaches the input handler, which clears
 *    the line first and only interrupts the run when there is nothing to clear.
 */
export function mountUI(session: Session, store: UIStore = new UIStore()): Instance {
  const instance = render(createElement(App, { session, store }), {
    exitOnCtrlC: false,
    patchConsole: true,
    incrementalRendering: true,
    maxFps: 30,
  })

  return instance
}
