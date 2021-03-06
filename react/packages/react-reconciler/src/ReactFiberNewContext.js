/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactContext} from 'shared/ReactTypes';
import type {Fiber} from './ReactFiber';
import type {StackCursor} from './ReactFiberStack';
import type {ExpirationTime} from './ReactFiberExpirationTime';

export type ContextDependency<T> = {
  context: ReactContext<T>,
  observedBits: number,
  next: ContextDependency<mixed> | null,
};

import warningWithoutStack from 'shared/warningWithoutStack';
import {isPrimaryRenderer} from './ReactFiberHostConfig';
import {createCursor, push, pop} from './ReactFiberStack';
import MAX_SIGNED_31_BIT_INT from './maxSigned31BitInt';
import {NoWork} from './ReactFiberExpirationTime';
import {ContextProvider, ClassComponent} from 'shared/ReactWorkTags';

import invariant from 'shared/invariant';
import warning from 'shared/warning';
import {
  createUpdate,
  enqueueUpdate,
  ForceUpdate,
} from 'react-reconciler/src/ReactUpdateQueue';

const valueCursor: StackCursor<mixed> = createCursor(null);

let rendererSigil;
if (__DEV__) {
  // Use this to detect multiple renderers using the same context
  rendererSigil = {};
}

let currentlyRenderingFiber: Fiber | null = null;
let lastContextDependency: ContextDependency<mixed> | null = null;
let lastContextWithAllBitsObserved: ReactContext<any> | null = null;

export function resetContextDependences(): void {
  // This is called right before React yields execution, to ensure `readContext`
  // cannot be called outside the render phase.
  currentlyRenderingFiber = null;
  lastContextDependency = null;
  lastContextWithAllBitsObserved = null;
}

export function pushProvider<T>(providerFiber: Fiber, nextValue: T): void {
  const context: ReactContext<T> = providerFiber.type._context;

  if (isPrimaryRenderer) { //定值，为true
    push(valueCursor, context._currentValue, providerFiber); //cursor只是存储每一个provider的context

    context._currentValue = nextValue; //context的当前值是直接挂载到context._currentValue上的，与cursor无关
    if (__DEV__) {
      warningWithoutStack(
        context._currentRenderer === undefined ||
          context._currentRenderer === null ||
          context._currentRenderer === rendererSigil,
        'Detected multiple renderers concurrently rendering the ' +
          'same context provider. This is currently unsupported.',
      );
      context._currentRenderer = rendererSigil;
    }
  } else {
    push(valueCursor, context._currentValue2, providerFiber);

    context._currentValue2 = nextValue;
    if (__DEV__) {
      warningWithoutStack(
        context._currentRenderer2 === undefined ||
          context._currentRenderer2 === null ||
          context._currentRenderer2 === rendererSigil,
        'Detected multiple renderers concurrently rendering the ' +
          'same context provider. This is currently unsupported.',
      );
      context._currentRenderer2 = rendererSigil;
    }
  }
}

export function popProvider(providerFiber: Fiber): void {
  const currentValue = valueCursor.current;

  pop(valueCursor, providerFiber);

  const context: ReactContext<any> = providerFiber.type._context;
  if (isPrimaryRenderer) {
    context._currentValue = currentValue;
  } else {
    context._currentValue2 = currentValue;
  }
}

export function calculateChangedBits<T>(
  context: ReactContext<T>,
  newValue: T,
  oldValue: T,
) {
  // Use Object.is to compare the new context value to the old value. Inlined
  // Object.is polyfill.
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/is
  if (
    (oldValue === newValue && //适用于大多数情况，如：-0 === +0返回true=》不正确，从二进制位上来说会有一个标志位的不同，以及NaN 应该等于 NaN
      (oldValue !== 0 || 1 / oldValue === 1 / (newValue: any))) || //+0（0）和-0区分开（+0和-0区分除0）：1 / +0为Infinity正无穷，1 / -0为-Infinity负无穷，除的结果对比来排除+0和-0
    (oldValue !== oldValue && newValue !== newValue) // eslint-disable-line no-self-compare  排除NaN，正常NaN !== NaN，且NaN也不等于自己
  ) { //对比oldValue和newValue，利用了polyfill：es6的Object.is()，更准确的判断两个值是否完全相等，满足此条件证明两个值全等
    // No change
    return 0; //上一次的值和这一次的没有任何字节变化 oldValue === newValue排除0和-0  ||　两个都是NaN
  } else { //目前createContext API 官方上是没有传_calculateChangedBits这个方法的
    const changedBits =
      typeof context._calculateChangedBits === 'function'
        ? context._calculateChangedBits(oldValue, newValue)
        : MAX_SIGNED_31_BIT_INT; //javascript最大的数，即二进制32都是1

    if (__DEV__) {
      warning(
        (changedBits & MAX_SIGNED_31_BIT_INT) === changedBits,
        'calculateChangedBits: Expected the return value to be a ' +
          '31-bit integer. Instead received: %s',
        changedBits,
      );
    }
    return changedBits | 0; //| 0把小数部分去掉，只留整数部分
  }
}

export function propagateContextChange(
  workInProgress: Fiber,
  context: ReactContext<mixed>,
  changedBits: number,
  renderExpirationTime: ExpirationTime,
): void {
  let fiber = workInProgress.child;
  if (fiber !== null) {
    // Set the return pointer of the child to the work-in-progress fiber.
    fiber.return = workInProgress;
  }
  while (fiber !== null) {
    let nextFiber;

    // Visit this fiber.
    let dependency = fiber.firstContextDependency; 　//Consumer组件据有的
    if (dependency !== null) { //子元素中找到了Consumer组件
      do {
        // Check if the context matches.
        if (
          dependency.context === context && //遍历的这个组件的context：dependency.context是依赖于当前组件的context，即context变化依赖的组件就需要更新
          (dependency.observedBits & changedBits) !== 0 //changedBits为32位全为1的二进制，只要dependency.observedBits不是0， &changedBits的结果都不是0（出现1个位置为1就结果=1），&=》交集部分（依赖的部分）发生了更新
        ) {
          // Match! Schedule an update on this fiber.

          if (fiber.tag === ClassComponent) {
            // Schedule a force update on the work-in-progress.
            const update = createUpdate(renderExpirationTime); //context change了，依赖这个context的组件依赖的context变化，即这个组件需要重新渲染，一个组件自身实现更新只能通过setState，而beginWork中会判断组件的expiretionTime，若是nowork即本身没有更新会执行跳过更新，而此处需要更新这个组件，所以此处主动创建这个组件的更新
            update.tag = ForceUpdate; //注意tag为ForceUpdate，因为这个组件本身没有更新，只是依赖了当前的context，context发生了变化，所以需要重新渲染
            // TODO: Because we don't have a work-in-progress, this will add the
            // update to the current fiber, too, which means it will persist even if
            // this render is thrown away. Since it's a race condition, not sure it's
            // worth fixing.
            enqueueUpdate(fiber, update); //当执行到这个组件时，发现有update就会执行更新
          }

          //只有classComponent才会主动创建更新，其他只需要修改fiber.expirationTime、fiber.alternate.expirationTime,修改后子链上组件优先级发生变化，那么还需更新父链上的childExpirationTime
          if (
            fiber.expirationTime === NoWork ||
            fiber.expirationTime > renderExpirationTime
          ) { //若是这个组件优先级不高，那么优先级改为此次组件更新的优先级，保证该组件在本次渲染过程中一定会执行到
            fiber.expirationTime = renderExpirationTime;
          }
          let alternate = fiber.alternate; //current也要执行优先级的改变
          if (
            alternate !== null &&
            (alternate.expirationTime === NoWork ||
              alternate.expirationTime > renderExpirationTime)
          ) {
            alternate.expirationTime = renderExpirationTime;
          }
          // Update the child expiration time of all the ancestors, including
          // the alternates.
          let node = fiber.return;
          while (node !== null) { //因为子元素的优先级发生改变，所以此处要修改父元素链上的childExpirationTime
            alternate = node.alternate;
            if (
              node.childExpirationTime === NoWork ||
              node.childExpirationTime > renderExpirationTime
            ) {
              node.childExpirationTime = renderExpirationTime;
              if (
                alternate !== null &&
                (alternate.childExpirationTime === NoWork ||
                  alternate.childExpirationTime > renderExpirationTime)
              ) {
                alternate.childExpirationTime = renderExpirationTime;
              }
            } else if (
              alternate !== null &&
              (alternate.childExpirationTime === NoWork ||
                alternate.childExpirationTime > renderExpirationTime)
            ) {
              alternate.childExpirationTime = renderExpirationTime;
            } else {
              // Neither alternate was updated, which means the rest of the
              // ancestor path already has sufficient priority.
              break;
            }
            node = node.return;
          }
        }
        nextFiber = fiber.child;
        dependency = dependency.next;
      } while (dependency !== null);
    } else if (fiber.tag === ContextProvider) {
      // Don't scan deeper if this is a matching provider
      nextFiber = fiber.type === workInProgress.type ? null : fiber.child;
    } else {
      // Traverse down.
      nextFiber = fiber.child;
    }

    if (nextFiber !== null) { //遍历所有子树，子树遍历玩遍历sibling兄弟节点
      // Set the return pointer of the child to the work-in-progress fiber.
      nextFiber.return = fiber;
    } else {
      // No child. Traverse to next sibling.
      nextFiber = fiber;
      while (nextFiber !== null) {
        if (nextFiber === workInProgress) {
          // We're back to the root of this subtree. Exit.
          nextFiber = null;
          break;
        }
        let sibling = nextFiber.sibling;
        if (sibling !== null) {
          // Set the return pointer of the sibling to the work-in-progress fiber.
          sibling.return = nextFiber.return;
          nextFiber = sibling;
          break;
        }
        // No more siblings. Traverse up.
        nextFiber = nextFiber.return;
      }
    }
    fiber = nextFiber;
  }
}

export function prepareToReadContext(
  workInProgress: Fiber,
  renderExpirationTime: ExpirationTime,
): void {
  currentlyRenderingFiber = workInProgress; //currentlyRenderingFiber当前要更新的组件
  lastContextDependency = null;
  lastContextWithAllBitsObserved = null;

  // Reset the work-in-progress list
  workInProgress.firstContextDependency = null;
}

export function readContext<T>(
  context: ReactContext<T>,
  observedBits: void | number | boolean,
): T {
  if (lastContextWithAllBitsObserved === context) {
    // Nothing to do. We already observe everything in this context.
  } else if (observedBits === false || observedBits === 0) { //observedBits未传入值，为undefined，不符合
    // Do not observe any updates.
  } else {
    let resolvedObservedBits; // Avoid deopting on observable arguments or heterogeneous types.
    if (
      typeof observedBits !== 'number' || //typeof undefined为undefined即符合!== 'number'
      observedBits === MAX_SIGNED_31_BIT_INT
    ) {
      // Observe all updates.
      lastContextWithAllBitsObserved = ((context: any): ReactContext<mixed>);
      resolvedObservedBits = MAX_SIGNED_31_BIT_INT;
    } else {
      resolvedObservedBits = observedBits;
    }

    let contextItem = {
      context: ((context: any): ReactContext<mixed>),
      observedBits: resolvedObservedBits,
      next: null,
    };

    if (lastContextDependency === null) {
      invariant(
        currentlyRenderingFiber !== null,
        'Context can only be read while React is ' +
          'rendering, e.g. inside the render method or getDerivedStateFromProps.',
      );
      // This is the first dependency in the list
      currentlyRenderingFiber.firstContextDependency = lastContextDependency = contextItem;
    } else {
      // Append a new context item.
      lastContextDependency = lastContextDependency.next = contextItem; //读取多个context=》可能为了hook用的，Consumer此处未用到
    }
  }
  return isPrimaryRenderer ? context._currentValue : context._currentValue2;
}
