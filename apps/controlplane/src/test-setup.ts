/**
 * Vitest 全局 setup 文件。
 *
 * @testing-library/dom 通过检测 `jest` 全局来判断是否处于 fake timers 环境。
 * 在 vitest 中 `jest` 全局默认不存在，导致 waitFor 在 fake timers 模式下走真实 timer
 * 路径（setInterval），被 fake timer 劫持后永远不会触发，测试超时。
 *
 * 此 setup 将 `jest` 指向 vitest 的 `vi` 对象，让 @testing-library/dom 能正确
 * 识别 fake timers 并使用 jest.advanceTimersByTime（即 vi.advanceTimersByTime）。
 */
import { vi } from 'vitest'

// 将 vi 挂载为 jest 全局，让 @testing-library/dom 识别 vitest fake timers
;(globalThis as unknown as Record<string, unknown>).jest = vi
