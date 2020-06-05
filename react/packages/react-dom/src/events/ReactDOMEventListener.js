/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {AnyNativeEvent} from 'events/PluginModuleType';
import type {Fiber} from 'react-reconciler/src/ReactFiber';
import type {DOMTopLevelEventType} from 'events/TopLevelEventTypes';

import {batchedUpdates, interactiveUpdates} from 'events/ReactGenericBatching';
import {runExtractedEventsInBatch} from 'events/EventPluginHub';
import {isFiberMounted} from 'react-reconciler/reflection';
import {HostRoot} from 'shared/ReactWorkTags';

import {addEventBubbleListener, addEventCaptureListener} from './EventListener';
import getEventTarget from './getEventTarget';
import {getClosestInstanceFromNode} from '../client/ReactDOMComponentTree';
import SimpleEventPlugin from './SimpleEventPlugin';
import {getRawEventName} from './DOMTopLevelEventTypes';

const {isInteractiveTopLevelEventType} = SimpleEventPlugin;

const CALLBACK_BOOKKEEPING_POOL_SIZE = 10;
const callbackBookkeepingPool = [];

/**
 * Find the deepest React component completely containing the root of the
 * passed-in instance (for use when entire React trees are nested within each
 * other). If React trees are not nested, returns null.
 */
function findRootContainerNode(inst) {
  // TODO: It may be a good idea to cache this to prevent unnecessary DOM
  // traversal, but caching is difficult to do correctly without using a
  // mutation observer to listen for all DOM changes.
  while (inst.return) {
    inst = inst.return;
  }
  if (inst.tag !== HostRoot) {
    // This can happen if we're in a detached tree.
    return null;
  }
  return inst.stateNode.containerInfo;
}

// Used to store ancestor hierarchy in top level callback
function getTopLevelCallbackBookKeeping(
  topLevelType,
  nativeEvent,
  targetInst,
): {
  topLevelType: ?DOMTopLevelEventType,
  nativeEvent: ?AnyNativeEvent,
  targetInst: Fiber | null,
  ancestors: Array<Fiber>,
} {
  if (callbackBookkeepingPool.length) {
    const instance = callbackBookkeepingPool.pop();
    instance.topLevelType = topLevelType;
    instance.nativeEvent = nativeEvent;
    instance.targetInst = targetInst;
    return instance;
  }
  return {
    topLevelType,
    nativeEvent,
    targetInst,
    ancestors: [],
  };
}

function releaseTopLevelCallbackBookKeeping(instance) {
  instance.topLevelType = null;
  instance.nativeEvent = null;
  instance.targetInst = null;
  instance.ancestors.length = 0;
  if (callbackBookkeepingPool.length < CALLBACK_BOOKKEEPING_POOL_SIZE) {
    callbackBookkeepingPool.push(instance);
  }
}

function handleTopLevel(bookKeeping) {
  let targetInst = bookKeeping.targetInst;

  // Loop through the hierarchy, in case there's any nested components.
  // It's important that we build the array of ancestors before calling any
  // event handlers, because event handlers can modify the DOM, leading to
  // inconsistencies with ReactMount's node cache. See #1105.
  let ancestor = targetInst;
  do {
    if (!ancestor) {
      bookKeeping.ancestors.push(ancestor); //ancestor不存在，所以push的是null
      break;
    }
    const root = findRootContainerNode(ancestor);  //根据ancestor一层层网上找到HostRoot.stadeNode.containerInfo，即挂载整个应用的那个container
    if (!root) {
      break;
    }
    bookKeeping.ancestors.push(ancestor);
    ancestor = getClosestInstanceFromNode(root); //找root这个node节点或其某层return上存储的fiber对象，正常HostRoot已经没有return了但是防止通过某些hack手段又渲染其他root，因为冒泡阶段要冒泡到最顶层，所以为了防止这种情况继续想上找fiber
  } while (ancestor);

  for (let i = 0; i < bookKeeping.ancestors.length; i++) {  //初次进入上面的循环满足if (!ancestor)，那么ancestors数组中也加入了值，即使值为null
    targetInst = bookKeeping.ancestors[i];  //大多数应用就是传入的那个targetInst
    runExtractedEventsInBatch(
      bookKeeping.topLevelType,
      targetInst,
      bookKeeping.nativeEvent,
      getEventTarget(bookKeeping.nativeEvent),  //获取event.target
    );
  }
}

// TODO: can we stop exporting these?
export let _enabled = true;

export function setEnabled(enabled: ?boolean) {
  _enabled = !!enabled;
}

export function isEnabled() {
  return _enabled;
}

/**
 * Traps top-level events by using event bubbling.
 *
 * @param {number} topLevelType Number from `TopLevelEventTypes`.
 * @param {object} element Element on which to attach listener.
 * @return {?object} An object with a remove function which will forcefully
 *                  remove the listener.
 * @internal
 */
export function trapBubbledEvent(
  topLevelType: DOMTopLevelEventType,
  element: Document | Element,
) {
  if (!element) {
    return null;
  }
  const dispatch = isInteractiveTopLevelEventType(topLevelType)  //判断topLevelType方法是不是interactive事件
    ? dispatchInteractiveEvent   //interactive事件的回调函数
    : dispatchEvent;  //非interactive事件的回调函数

  addEventBubbleListener(  //该方法就是最终来调用element.addEventListener的
    element,
    getRawEventName(topLevelType),  //addEventListener监听的事件类型 
    // Check if interactive and wrap in interactiveUpdates
    dispatch.bind(null, topLevelType),  //addEventListener监听事件的回调，即dispatch(topLevelType)预设定第一个参数为topLevelType，this指向null即普通函数调用
  );// addEventBubbleListener：element.addEventListener(eventType, listener, false); //冒泡事件最后一个参数是false，eventType为getRawEventName(topLevelType)，listener为dispatch.bind(null, topLevelType)
}

/**
 * Traps a top-level event by using event capturing.
 *
 * @param {number} topLevelType Number from `TopLevelEventTypes`.
 * @param {object} element Element on which to attach listener.
 * @return {?object} An object with a remove function which will forcefully
 *                  remove the listener.
 * @internal
 */
export function trapCapturedEvent(
  topLevelType: DOMTopLevelEventType,
  element: Document | Element,
) {
  if (!element) {
    return null;
  }
  const dispatch = isInteractiveTopLevelEventType(topLevelType)
    ? dispatchInteractiveEvent
    : dispatchEvent;

  addEventCaptureListener(
    element,
    getRawEventName(topLevelType),
    // Check if interactive and wrap in interactiveUpdates
    dispatch.bind(null, topLevelType),
  );
}

function dispatchInteractiveEvent(topLevelType, nativeEvent) { //上面两个方法trapBubbledEvent、trapCapturedEvent过来只穿了一个参数，nativeEvent为undefined
  interactiveUpdates(dispatchEvent, topLevelType, nativeEvent); //return dispatchEvent(topLevelType, nativeEvent)
}

export function dispatchEvent(
  topLevelType: DOMTopLevelEventType,
  nativeEvent: AnyNativeEvent,
) {
  if (!_enabled) {
    return;
  }

  const nativeEventTarget = getEventTarget(nativeEvent); //获取event.target，这是一个pollyfill,，出于对各种系统的兼容性考虑
  let targetInst = getClosestInstanceFromNode(nativeEventTarget); //根据这个nativeEventTarget node节点找到其上挂载fiber对象的属性，获取对应的fiber(本身没有去父元素上找)
  if (
    targetInst !== null &&
    typeof targetInst.tag === 'number' &&  //react中存储tag使用是二进制的方式存储的，所以typof返回的一定是number，若不是则一定不是fiber对象
    !isFiberMounted(targetInst)  //判断fiber对象对应的这个dom节点是不是已经被挂载
  ) {
    // If we get an event (ex: img onload) before committing that
    // component's mount, ignore it for now (that is, treat it as if it was an
    // event on a non-React tree). We might also consider queueing events and
    // dispatching them after the mount.
    targetInst = null;
  }

  const bookKeeping = getTopLevelCallbackBookKeeping(
    topLevelType,
    nativeEvent,
    targetInst,
  );  //return {topLevelType,nativeEvent,targetInst,ancestors: []}就是将这三个属性及一个空数组ancestors封装成一个对象返回，用于来记录这些个值

  try {
    // Event queue being processed in the same cycle allows
    // `preventDefault`.
    batchedUpdates(handleTopLevel, bookKeeping); //handleTopLevel(bookKeeping);之后进行受控组件的处理input value onChange事实展示value的变化
  } finally {
    releaseTopLevelCallbackBookKeeping(bookKeeping);
  }
}
