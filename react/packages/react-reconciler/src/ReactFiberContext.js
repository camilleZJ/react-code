/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber} from './ReactFiber';
import type {StackCursor} from './ReactFiberStack';

import {isFiberMounted} from 'react-reconciler/reflection';
import {ClassComponent, HostRoot} from 'shared/ReactWorkTags';
import getComponentName from 'shared/getComponentName';
import invariant from 'shared/invariant';
import warningWithoutStack from 'shared/warningWithoutStack';
import checkPropTypes from 'prop-types/checkPropTypes';

import * as ReactCurrentFiber from './ReactCurrentFiber';
import {startPhaseTimer, stopPhaseTimer} from './ReactDebugFiberPerf';
import {createCursor, push, pop} from './ReactFiberStack';

let warnedAboutMissingGetChildContext;

if (__DEV__) {
  warnedAboutMissingGetChildContext = {};
}

export const emptyContextObject = {};
if (__DEV__) {
  Object.freeze(emptyContextObject);
}

// A cursor to the current merged context object on the stack.
let contextStackCursor: StackCursor<Object> = createCursor(emptyContextObject); //记录当前更新到某个节点之后应该可以拿到的context对应的所有值
// A cursor to a boolean indicating whether the context has changed.
let didPerformWorkStackCursor: StackCursor<boolean> = createCursor(false); //更新到某个节点之后这个context值是否有变化
// Keep track of the previous context object that was on the stack.
// We use this to get access to the parent context after we have already
// pushed the next context provider, and now need to merge their contexts.
let previousContext: Object = emptyContextObject;

function getUnmaskedContext(
  workInProgress: Fiber,
  Component: Function,
  didPushOwnContextIfProvider: boolean,  //是否已经push了自己的context provider--提供context的provider
): Object {
  if (didPushOwnContextIfProvider && isContextProvider(Component)) {
    // If the fiber is a context provider itself, when we read its context
    // we may have already pushed its own child context on the stack. A context
    // provider should not "see" its own child context. Therefore we read the
    // previous (parent) context instead for a context provider.
    return previousContext;  //push之前的cursor.current，context来源于其provider提供的，而不是自己提供的，自己提供的context是给其children用的
  }
  return contextStackCursor.current; 
}

function cacheContext(
  workInProgress: Fiber,
  unmaskedContext: Object,
  maskedContext: Object,
): void {
  const instance = workInProgress.stateNode;
  instance.__reactInternalMemoizedUnmaskedChildContext = unmaskedContext;
  instance.__reactInternalMemoizedMaskedChildContext = maskedContext;
}

function getMaskedContext(
  workInProgress: Fiber,
  unmaskedContext: Object,
): Object {
  const type = workInProgress.type;
  const contextTypes = type.contextTypes;
  if (!contextTypes) {
    return emptyContextObject;
  }

  // Avoid recreating masked context unless unmasked context has changed.
  // Failing to do this will result in unnecessary calls to componentWillReceiveProps.
  // This may trigger infinite loops if componentWillReceiveProps calls setState.
  const instance = workInProgress.stateNode;
  if (
    instance &&
    instance.__reactInternalMemoizedUnmaskedChildContext === unmaskedContext
  ) {
    return instance.__reactInternalMemoizedMaskedChildContext;
  }

  const context = {};
  for (let key in contextTypes) {
    context[key] = unmaskedContext[key]; //provider提供的context中有很多值，但是某个children不一定全用到，只拿出更新的该组件中使用到的context
  }

  if (__DEV__) {
    const name = getComponentName(type) || 'Unknown';
    checkPropTypes(
      contextTypes,
      context,
      'context',
      name,
      ReactCurrentFiber.getCurrentFiberStackInDev,
    );
  }

  // Cache unmasked context so we can avoid recreating masked context unless necessary.
  // Context is created before the class component is instantiated so check for instance.
  if (instance) {
    cacheContext(workInProgress, unmaskedContext, context);
  }

  return context;
}

function hasContextChanged(): boolean {
  return didPerformWorkStackCursor.current;
}

function isContextProvider(type: Function): boolean { //作为propvider的会有childContextTypes属性
  const childContextTypes = type.childContextTypes;
  return childContextTypes !== null && childContextTypes !== undefined;
}

function popContext(fiber: Fiber): void {
  pop(didPerformWorkStackCursor, fiber);
  pop(contextStackCursor, fiber); //注意push的时候先push contextStackCursor再didPerformWorkStackCursor以确保更新的context的顺序(stack中cursor的位置才能使对应起来的)：push的时候按照顺序，pop的时候要反过来
}

function popTopLevelContextObject(fiber: Fiber): void {
  pop(didPerformWorkStackCursor, fiber);
  pop(contextStackCursor, fiber); 
}

function pushTopLevelContextObject(
  fiber: Fiber,
  context: Object,
  didChange: boolean,
): void {
  invariant(
    contextStackCursor.current === emptyContextObject,
    'Unexpected context found on stack. ' +
      'This error is likely caused by a bug in React. Please file an issue.',
  );

  push(contextStackCursor, context, fiber);
  push(didPerformWorkStackCursor, didChange, fiber);
}

function processChildContext(
  fiber: Fiber,
  type: any,
  parentContext: Object,
): Object {
  const instance = fiber.stateNode;
  const childContextTypes = type.childContextTypes;

  // TODO (bvaughn) Replace this behavior with an invariant() in the future.
  // It has only been added in Fiber to match the (unintentional) behavior in Stack.
  if (typeof instance.getChildContext !== 'function') { // 没有getChildContext function说明次节点不是context的提供者，那么context的值是其父级的context
    if (__DEV__) {
      const componentName = getComponentName(type) || 'Unknown';

      if (!warnedAboutMissingGetChildContext[componentName]) {
        warnedAboutMissingGetChildContext[componentName] = true;
        warningWithoutStack(
          false,
          '%s.childContextTypes is specified but there is no getChildContext() method ' +
            'on the instance. You can either define getChildContext() on %s or remove ' +
            'childContextTypes from it.',
          componentName,
          componentName,
        );
      }
    }
    return parentContext;
  }

  let childContext;
  if (__DEV__) {
    ReactCurrentFiber.setCurrentPhase('getChildContext');
  }
  startPhaseTimer(fiber, 'getChildContext');
  childContext = instance.getChildContext(); //调用getChildContext方法获取return的object
  stopPhaseTimer();
  if (__DEV__) {
    ReactCurrentFiber.setCurrentPhase(null);
  }
  for (let contextKey in childContext) {
    invariant(
      contextKey in childContextTypes,
      '%s.getChildContext(): key "%s" is not defined in childContextTypes.',
      getComponentName(type) || 'Unknown',
      contextKey,
    );
  }
  if (__DEV__) {
    const name = getComponentName(type) || 'Unknown';
    checkPropTypes(
      childContextTypes,
      childContext,
      'child context',
      name,
      // In practice, there is one case in which we won't get a stack. It's when
      // somebody calls unstable_renderSubtreeIntoContainer() and we process
      // context from the parent component instance. The stack will be missing
      // because it's outside of the reconciliation, and so the pointer has not
      // been set. This is rare and doesn't matter. We'll also remove that API.
      ReactCurrentFiber.getCurrentFiberStackInDev,
    );
  }

  return {...parentContext, ...childContext}; //parent的context和child的context合并，child放在最后=》后者覆盖前者，即key相同child的context会覆盖parent的context
}

function pushContextProvider(workInProgress: Fiber): boolean {
  const instance = workInProgress.stateNode;
  // We push the context as early as possible to ensure stack integrity.
  // If the instance does not exist yet, we will push null at first,
  // and replace it on the stack later when invalidating the context.
  const memoizedMergedChildContext =
    (instance && instance.__reactInternalMemoizedMergedChildContext) ||
    emptyContextObject;  //通过挂载到instance上的属性来获取context的值

  // Remember the parent context so we can merge with it later.
  // Inherit the parent's did-perform-work value to avoid inadvertently blocking updates.
  previousContext = contextStackCursor.current;
  push(contextStackCursor, memoizedMergedChildContext, workInProgress); //将contextStackCursor.current入栈valueStack：之后将instance上新的值挂载到contextStackCursor.current上
  push(
    didPerformWorkStackCursor,
    didPerformWorkStackCursor.current,
    workInProgress,
  ); //将之前的current入栈，但是当前的current还是等于入栈的值=》保持原样只是同时将此值入了栈valueStack

  return true;
}

function invalidateContextProvider(
  workInProgress: Fiber,
  type: any,
  didChange: boolean,  //context是否有变化
): void {
  const instance = workInProgress.stateNode;
  invariant(
    instance,
    'Expected to have an instance by this point. ' +
      'This error is likely caused by a bug in React. Please file an issue.',
  );

  if (didChange) {
    // Merge parent and own context.
    // Skip this if we're not updating due to sCU.
    // This avoids unnecessarily recomputing memoized values.
    const mergedContext = processChildContext(
      workInProgress,
      type,
      previousContext,
    ); //计算新的context
    instance.__reactInternalMemoizedMergedChildContext = mergedContext; //将新的context通过属性挂载到instance上

    // Replace the old (or empty) context with the new one.
    // It is important to unwind the context in the reverse order.
    pop(didPerformWorkStackCursor, workInProgress);
    pop(contextStackCursor, workInProgress);  //ReactFiberBeginWork.js-》updateClassComponent：push了此处pop来使cursor.current获取旧值，便于以下push新值
    // Now push the new context and mark that it has changed.
    push(contextStackCursor, mergedContext, workInProgress); //cursor.current旧值入栈，并将新的context赋值给cursor.current
    push(didPerformWorkStackCursor, didChange, workInProgress);
  } else {
    pop(didPerformWorkStackCursor, workInProgress);
    push(didPerformWorkStackCursor, didChange, workInProgress);
  }
}

function findCurrentUnmaskedContext(fiber: Fiber): Object {
  // Currently this is only used with renderSubtreeIntoContainer; not sure if it
  // makes sense elsewhere
  invariant(
    isFiberMounted(fiber) && fiber.tag === ClassComponent,
    'Expected subtree parent to be a mounted class component. ' +
      'This error is likely caused by a bug in React. Please file an issue.',
  );

  let node = fiber;
  do {
    switch (node.tag) {
      case HostRoot:
        return node.stateNode.context;
      case ClassComponent: {
        const Component = node.type;
        if (isContextProvider(Component)) {
          return node.stateNode.__reactInternalMemoizedMergedChildContext;
        }
        break;
      }
    }
    node = node.return;
  } while (node !== null);
  invariant(
    false,
    'Found unexpected detached subtree parent. ' +
      'This error is likely caused by a bug in React. Please file an issue.',
  );
}

export {
  getUnmaskedContext,
  cacheContext,
  getMaskedContext,
  hasContextChanged,
  popContext,
  popTopLevelContextObject,
  pushTopLevelContextObject,
  processChildContext,
  isContextProvider,
  pushContextProvider,
  invalidateContextProvider,
  findCurrentUnmaskedContext,
};
