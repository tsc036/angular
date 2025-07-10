/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  REACTIVE_NODE,
  ReactiveNode,
  SIGNAL,
  consumerAfterComputation,
  consumerBeforeComputation,
  consumerDestroy,
  consumerPollProducersForChange,
  isInNotificationPhase,
  setActiveConsumer,
  ReactiveNodeImpl,
  getActiveConsumer,
} from '../../../primitives/signals';
import {FLAGS, LViewFlags, LView, EFFECTS} from '../interfaces/view';
import {markAncestorsForTraversal} from '../util/view_utils';
import {inject} from '../../di/injector_compatibility';
import {Injector} from '../../di/injector';
import {assertNotInReactiveContext} from './asserts';
import {assertInInjectionContext} from '../../di/contextual';
import {DestroyRef, NodeInjectorDestroyRef} from '../../linker/destroy_ref';
import {ViewContext} from '../view_context';
import {noop} from '../../util/noop';
import {
  ChangeDetectionScheduler,
  NotificationSource,
} from '../../change_detection/scheduling/zoneless_scheduling';
import {setIsRefreshingViews} from '../state';
import {EffectScheduler, SchedulableEffect} from './root_effect_scheduler';

import {emitEffectCreatedEvent, setInjectorProfilerContext} from '../debug/injector_profiler';

/**
 * A global reactive effect, which can be manually destroyed.
 *
 * @publicApi 20.0
 */
export interface EffectRef {
  /**
   * Shut down the effect, removing it from any upcoming scheduled executions.
   */
  destroy(): void;
}

export class EffectRefImpl implements EffectRef {
  [SIGNAL]: Effect;

  constructor(node: Effect) {
    this[SIGNAL] = node;
  }

  destroy(): void {
    this[SIGNAL].destroy();
  }
}

/**
 * Options passed to the `effect` function.
 *
 * @publicApi 20.0
 */
export interface CreateEffectOptions {
  /**
   * The `Injector` in which to create the effect.
   *
   * If this is not provided, the current [injection context](guide/di/dependency-injection-context)
   * will be used instead (via `inject`).
   */
  injector?: Injector;

  /**
   * Whether the `effect` should require manual cleanup.
   *
   * If this is `false` (the default) the effect will automatically register itself to be cleaned up
   * with the current `DestroyRef`.
   *
   * If this is `true` and you want to use the effect outside an injection context, you still
   * need to provide an `Injector` to the effect.
   */
  manualCleanup?: boolean;

  /**
   * @deprecated no longer required, signal writes are allowed by default.
   */
  allowSignalWrites?: boolean;

  /**
   * A debug name for the effect. Used in Angular DevTools to identify the effect.
   */
  debugName?: string;
}

/**
 * An effect can, optionally, register a cleanup function. If registered, the cleanup is executed
 * before the next effect run. The cleanup function makes it possible to "cancel" any work that the
 * previous effect run might have started.
 *
 * @publicApi 20.0
 */
export type EffectCleanupFn = () => void;

/**
 * A callback passed to the effect function that makes it possible to register cleanup logic.
 *
 * @publicApi 20.0
 */
export type EffectCleanupRegisterFn = (cleanupFn: EffectCleanupFn) => void;

/**
 * Registers an "effect" that will be scheduled & executed whenever the signals that it reads
 * changes.
 *
 * Angular has two different kinds of effect: component effects and root effects. Component effects
 * are created when `effect()` is called from a component, directive, or within a service of a
 * component/directive. Root effects are created when `effect()` is called from outside the
 * component tree, such as in a root service.
 *
 * The two effect types differ in their timing. Component effects run as a component lifecycle
 * event during Angular's synchronization (change detection) process, and can safely read input
 * signals or create/destroy views that depend on component state. Root effects run as microtasks
 * and have no connection to the component tree or change detection.
 *
 * `effect()` must be run in injection context, unless the `injector` option is manually specified.
 *
 * @publicApi 20.0
 */
export function effect(
  effectFn: (onCleanup: EffectCleanupRegisterFn) => void,
  options?: CreateEffectOptions,
): EffectRef {
  ngDevMode &&
    assertNotInReactiveContext(
      effect,
      'Call `effect` outside of a reactive context. For example, schedule the ' +
        'effect inside the component constructor.',
    );

  if (ngDevMode && !options?.injector) {
    assertInInjectionContext(effect);
  }

  if (ngDevMode && options?.allowSignalWrites !== undefined) {
    console.warn(
      `The 'allowSignalWrites' flag is deprecated and no longer impacts effect() (writes are always allowed)`,
    );
  }

  const injector = options?.injector ?? inject(Injector);
  let destroyRef = options?.manualCleanup !== true ? injector.get(DestroyRef) : null;

  let node: Effect;

  const viewContext = injector.get(ViewContext, null, {optional: true});
  const notifier = injector.get(ChangeDetectionScheduler);
  if (viewContext !== null) {
    // This effect was created in the context of a view, and will be associated with the view.
    if (destroyRef instanceof NodeInjectorDestroyRef && destroyRef._lView === viewContext.view) {
      // The effect is being created in the same view as the `DestroyRef` references, so it will be
      // automatically destroyed without the need for an explicit `DestroyRef` registration.
      destroyRef = null;
    }
    node = new ViewEffectClassImpl(effectFn, viewContext.view, notifier, destroyRef, options);
  } else {
    // This effect was created outside the context of a view, and will be scheduled independently.
    node = new RootEffectClassImpl(
      effectFn,
      notifier,
      injector.get(EffectScheduler),
      destroyRef,
      options,
    );
  }
  const effectRef = new EffectRefImpl(node);

  if (ngDevMode) {
    node.debugName = options?.debugName ?? '';
    const prevInjectorProfilerContext = setInjectorProfilerContext({injector, token: null});
    try {
      emitEffectCreatedEvent(node);
    } finally {
      setInjectorProfilerContext(prevInjectorProfilerContext);
    }
  }

  return effectRef;
}

export interface EffectNode extends ReactiveNode, SchedulableEffect {
  hasRun: boolean;
  cleanupFns: EffectCleanupFn[] | undefined;
  injector: Injector;
  notifier: ChangeDetectionScheduler;

  onDestroyFn: () => void;
  fn: (cleanupFn: EffectCleanupRegisterFn) => void;
  run(): void;
  destroy(): void;
  maybeCleanup(): void;
}

interface Effect extends ReactiveNode {
  run(): void;
  destroy(): void;
  debugName?: string;
}

export class EffectImpl extends ReactiveNodeImpl implements Effect {
  hasRun = false;
  override dirty = true;
  debugName?: string;
  cleanupFn: EffectCleanupRegisterFn = noop;
  constructor(readonly effectFn: (cleanupFn: EffectCleanupRegisterFn) => void) {
    super();
  }
  override get kind() {
    return 'effect';
  }
  cleanup(): void {}
  destroy(): void {
    consumerDestroy(this);
  }
  override consumerMarkedDirty(): void {
    this.run();
  }

  override get consumerIsAlwaysLive(): boolean {
    return true;
  }
  override get consumerAllowSignalWrites(): boolean {
    return true;
  }
  run(): void {
    if (this.hasRun && !consumerPollProducersForChange(this)) {
      return;
    }
    this.hasRun = true;
    this.dirty = false;
    this.cleanup();
    const prevConsumer = consumerBeforeComputation(this);
    try {
      this.effectFn(this.cleanupFn);
    } finally {
      consumerAfterComputation(this, prevConsumer);
    }
  }
}

export class AngularEffectBaseImpl extends EffectImpl implements SchedulableEffect, EffectRef {
  cleanupFns: EffectCleanupFn[] | undefined = undefined;
  zone = typeof Zone !== 'undefined' ? Zone.current : null;
  onDestroyFn: (() => void) | null = null;
  constructor(
    effectFn: (cleanupFn: EffectCleanupRegisterFn) => void,
    readonly notificationSource: NotificationSource,
    readonly notifier: ChangeDetectionScheduler,
    readonly destroyRef: DestroyRef | null,
    readonly options?: CreateEffectOptions,
  ) {
    super(effectFn);
    this.dirty = true;
    this.cleanupFn = onCleanup;
    if (destroyRef) {
      this.onDestroyFn = destroyRef.onDestroy(() => this.destroy());
    }
  }
  override cleanup(): void {
    if (!this.cleanupFns?.length) {
      return;
    }
    const prevConsumer = setActiveConsumer(null);
    try {
      // Attempt to run the cleanup functions. Regardless of failure or success,
      // we consider cleanup "completed" and clear the list for the next run of
      // the effect. Note that an error from the cleanup function will still
      // crash the current run of the effect.
      while (this.cleanupFns.length) {
        this.cleanupFns.pop()!();
      }
    } finally {
      this.cleanupFns = [];
      setActiveConsumer(prevConsumer);
    }
  }

  override consumerMarkedDirty() {
    this.notifier.notify(this.notificationSource);
  }

  override destroy() {
    super.destroy();
    this.cleanup();
    this.onDestroyFn?.();
  }
}

export class ViewEffectClassImpl extends AngularEffectBaseImpl implements ViewEffectNode {
  constructor(
    fn: (cleanupFn: EffectCleanupRegisterFn) => void,
    readonly view: LView,
    notifier: ChangeDetectionScheduler,
    destroyRef: DestroyRef | null,
    options?: CreateEffectOptions,
  ) {
    super(fn, NotificationSource.ViewEffect, notifier, destroyRef, options);
    view[EFFECTS] ??= new Set();
    view[EFFECTS].add(this);
  }

  override consumerMarkedDirty() {
    this.view[FLAGS] |= LViewFlags.HasChildViewsToRefresh;
    markAncestorsForTraversal(this.view);
    super.consumerMarkedDirty();
  }
  override destroy() {
    super.destroy();
    this.view[EFFECTS]?.delete(this);
  }
}

export class RootEffectClassImpl extends AngularEffectBaseImpl implements RootEffectNode {
  constructor(
    fn: (cleanupFn: EffectCleanupRegisterFn) => void,
    notifier: ChangeDetectionScheduler,
    readonly scheduler: EffectScheduler,
    destroyRef: DestroyRef | null,
    options?: CreateEffectOptions,
  ) {
    super(fn, NotificationSource.RootEffect, notifier, destroyRef, options);
    this.scheduler = scheduler;
    this.scheduler.add(this);
    this.notifier.notify(this.notificationSource);
  }
  override consumerMarkedDirty() {
    this.scheduler.schedule(this);
    super.consumerMarkedDirty();
  }
  override destroy() {
    super.destroy();
    this.scheduler.remove(this);
  }
}

function onCleanup(cleanupFn: EffectCleanupFn) {
  const currentConsumer = getActiveConsumer();
  if (currentConsumer instanceof AngularEffectBaseImpl) {
    currentConsumer.cleanupFns ||= [];
    currentConsumer.cleanupFns.push(cleanupFn);
  }
}

export interface ViewEffectNode extends Effect, SchedulableEffect {
  view: LView;
}

export interface RootEffectNode extends Effect, SchedulableEffect {
  scheduler: EffectScheduler;
}

// export const BASE_EFFECT_NODE: Omit<EffectNode, 'fn' | 'destroy' | 'injector' | 'notifier'> =
//   /* @__PURE__ */ (() => ({
//     ...REACTIVE_NODE,
//     consumerIsAlwaysLive: true,
//     consumerAllowSignalWrites: true,
//     dirty: true,
//     hasRun: false,
//     cleanupFns: undefined,
//     zone: null,
//     kind: 'effect',
//     onDestroyFn: noop,
//     run(this: EffectNode): void {
//       this.dirty = false;

//       if (ngDevMode && isInNotificationPhase()) {
//         throw new Error(`Schedulers cannot synchronously execute watches while scheduling.`);
//       }

//       if (this.hasRun && !consumerPollProducersForChange(this)) {
//         return;
//       }
//       this.hasRun = true;

//       const registerCleanupFn: EffectCleanupRegisterFn = (cleanupFn) =>
//         (this.cleanupFns ??= []).push(cleanupFn);

//       const prevNode = consumerBeforeComputation(this);

//       // We clear `setIsRefreshingViews` so that `markForCheck()` within the body of an effect will
//       // cause CD to reach the component in question.
//       const prevRefreshingViews = setIsRefreshingViews(false);
//       try {
//         this.maybeCleanup();
//         this.fn(registerCleanupFn);
//       } finally {
//         setIsRefreshingViews(prevRefreshingViews);
//         consumerAfterComputation(this, prevNode);
//       }
//     },

//     maybeCleanup(this: EffectNode): void {
//       if (!this.cleanupFns?.length) {
//         return;
//       }
//       const prevConsumer = setActiveConsumer(null);
//       try {
//         // Attempt to run the cleanup functions. Regardless of failure or success, we consider
//         // cleanup "completed" and clear the list for the next run of the effect. Note that an error
//         // from the cleanup function will still crash the current run of the effect.
//         while (this.cleanupFns.length) {
//           this.cleanupFns.pop()!();
//         }
//       } finally {
//         this.cleanupFns = [];
//         setActiveConsumer(prevConsumer);
//       }
//     },
//   }))();

// export const ROOT_EFFECT_NODE: Omit<RootEffectNode, 'fn' | 'scheduler' | 'notifier' | 'injector'> =
//   /* @__PURE__ */ (() => ({
//     ...BASE_EFFECT_NODE,
//     consumerMarkedDirty(this: RootEffectNode) {
//       this.scheduler.schedule(this);
//       this.notifier.notify(NotificationSource.RootEffect);
//     },
//     destroy(this: RootEffectNode) {
//       consumerDestroy(this);
//       this.onDestroyFn();
//       this.maybeCleanup();
//       this.scheduler.remove(this);
//     },
//   }))();

// export const VIEW_EFFECT_NODE: Omit<ViewEffectNode, 'fn' | 'view' | 'injector' | 'notifier'> =
//   /* @__PURE__ */ (() => ({
//     ...BASE_EFFECT_NODE,
//     consumerMarkedDirty(this: ViewEffectNode): void {
//       this.view[FLAGS] |= LViewFlags.HasChildViewsToRefresh;
//       markAncestorsForTraversal(this.view);
//       this.notifier.notify(NotificationSource.ViewEffect);
//     },
//     destroy(this: ViewEffectNode): void {
//       consumerDestroy(this);
//       this.onDestroyFn();
//       this.maybeCleanup();
//       this.view[EFFECTS]?.delete(this);
//     },
//   }))();

// export function createViewEffect(
//   view: LView,
//   notifier: ChangeDetectionScheduler,
//   fn: (onCleanup: EffectCleanupRegisterFn) => void,
// ): ViewEffectNode {
//   const node = Object.create(VIEW_EFFECT_NODE) as ViewEffectNode;
//   node.view = view;
//   node.zone = typeof Zone !== 'undefined' ? Zone.current : null;
//   node.notifier = notifier;
//   node.fn = fn;

//   view[EFFECTS] ??= new Set();
//   view[EFFECTS].add(node);

//   node.consumerMarkedDirty(node);
//   return node;
// }

// export function createRootEffect(
//   fn: (onCleanup: EffectCleanupRegisterFn) => void,
//   scheduler: EffectScheduler,
//   notifier: ChangeDetectionScheduler,
// ): RootEffectNode {
//   const node = Object.create(ROOT_EFFECT_NODE) as RootEffectNode;
//   node.fn = fn;
//   node.scheduler = scheduler;
//   node.notifier = notifier;
//   node.zone = typeof Zone !== 'undefined' ? Zone.current : null;
//   node.scheduler.add(node);
//   node.notifier.notify(NotificationSource.RootEffect);
//   return node;
// }
