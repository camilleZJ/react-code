/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber} from './ReactFiber';
import type {
  Instance,
  TextInstance,
  HydratableInstance,
  Container,
  HostContext,
} from './ReactFiberHostConfig';

import {HostComponent, HostText, HostRoot} from 'shared/ReactWorkTags';
import {Deletion, Placement} from 'shared/ReactSideEffectTags';
import invariant from 'shared/invariant';

import {createFiberFromHostInstanceForDeletion} from './ReactFiber';
import {
  shouldSetTextContent,
  supportsHydration,
  canHydrateInstance,
  canHydrateTextInstance,
  getNextHydratableSibling,
  getFirstHydratableChild,
  hydrateInstance,
  hydrateTextInstance,
  didNotMatchHydratedContainerTextInstance,
  didNotMatchHydratedTextInstance,
  didNotHydrateContainerInstance,
  didNotHydrateInstance,
  didNotFindHydratableContainerInstance,
  didNotFindHydratableContainerTextInstance,
  didNotFindHydratableInstance,
  didNotFindHydratableTextInstance,
} from './ReactFiberHostConfig';

// The deepest Fiber on the stack involved in a hydration context.
// This may have been an insertion or a hydration.
let hydrationParentFiber: null | Fiber = null;
let nextHydratableInstance: null | HydratableInstance = null;
let isHydrating: boolean = false;

function enterHydrationState(fiber: Fiber): boolean { //三个全局变量的初始化
  if (!supportsHydration) { //const supportsHydration = true
    return false;
  }

  const parentInstance = fiber.stateNode.containerInfo; //容器dom节点
  nextHydratableInstance = getFirstHydratableChild(parentInstance); //找到parentInstance下第一个合理的子节点，赋值给全局变量nextHydratableInstance
  hydrationParentFiber = fiber;
  isHydrating = true;
  return true;
}

function deleteHydratableInstance(
  returnFiber: Fiber,
  instance: HydratableInstance,
) {
  if (__DEV__) {
    switch (returnFiber.tag) {
      case HostRoot:
        didNotHydrateContainerInstance(
          returnFiber.stateNode.containerInfo,
          instance,
        );
        break;
      case HostComponent:
        didNotHydrateInstance(
          returnFiber.type,
          returnFiber.memoizedProps,
          returnFiber.stateNode,
          instance,
        );
        break;
    }
  }

  const childToDelete = createFiberFromHostInstanceForDeletion(); //单独创建了一个fiber对象
  childToDelete.stateNode = instance;
  childToDelete.return = returnFiber;
  childToDelete.effectTag = Deletion; //设置fiber对象的effectTag为Deletion

  // This might seem like it belongs on progressedFirstDeletion. However,
  // these children are not part of the reconciliation list of children.
  // Even if we abort and rereconcile the children, that will try to hydrate
  // again and the nodes are still in the host tree so these will be
  // recreated.
  if (returnFiber.lastEffect !== null) { //挂到effect链上在commit阶段执行删除
    returnFiber.lastEffect.nextEffect = childToDelete;
    returnFiber.lastEffect = childToDelete;
  } else {
    returnFiber.firstEffect = returnFiber.lastEffect = childToDelete;
  }
}

function insertNonHydratedInstance(returnFiber: Fiber, fiber: Fiber) {
  fiber.effectTag |= Placement; //需要插入的节点，添加effectTag
  if (__DEV__) {
    switch (returnFiber.tag) {
      case HostRoot: {
        const parentContainer = returnFiber.stateNode.containerInfo;
        switch (fiber.tag) {
          case HostComponent:
            const type = fiber.type;
            const props = fiber.pendingProps;
            didNotFindHydratableContainerInstance(parentContainer, type, props);
            break;
          case HostText:
            const text = fiber.pendingProps;
            didNotFindHydratableContainerTextInstance(parentContainer, text);
            break;
        }
        break;
      }
      case HostComponent: {
        const parentType = returnFiber.type;
        const parentProps = returnFiber.memoizedProps;
        const parentInstance = returnFiber.stateNode;
        switch (fiber.tag) {
          case HostComponent:
            const type = fiber.type;
            const props = fiber.pendingProps;
            didNotFindHydratableInstance(
              parentType,
              parentProps,
              parentInstance,
              type,
              props,
            );
            break;
          case HostText:
            const text = fiber.pendingProps;
            didNotFindHydratableTextInstance(
              parentType,
              parentProps,
              parentInstance,
              text,
            );
            break;
        }
        break;
      }
      default:
        return;
    }
  }
}

function tryHydrate(fiber, nextInstance) {
  switch (fiber.tag) {
    case HostComponent: {
      const type = fiber.type;
      const props = fiber.pendingProps;
      const instance = canHydrateInstance(nextInstance, type, props); //type、nextInstance都是合理的标签，并且类型一样即复用nextInstance
      if (instance !== null) {
        fiber.stateNode = (instance: Instance); //instance：nextInstance
        return true;
      }
      return false;
    }
    case HostText: {
      const text = fiber.pendingProps;
      const textInstance = canHydrateTextInstance(nextInstance, text); //text存在nextInstance也是TEXT_NODE就服用节点nextInstance
      if (textInstance !== null) {
        fiber.stateNode = (textInstance: TextInstance); //instance：nextInstance
        return true;
      }
      return false;
    }
    default:
      return false;
  }
}

function tryToClaimNextHydratableInstance(fiber: Fiber): void {
  if (!isHydrating) { 
    return;
  }
  let nextInstance = nextHydratableInstance; //container下第一个合理的子节点
  if (!nextInstance) { //container下没有合理的子节点，即当前正在更新的hostComponent是没有节点预期hydrate的流程，所以需要新增
    // Nothing to hydrate. Make it an insertion.
    insertNonHydratedInstance((hydrationParentFiber: any), fiber);  //该hostComponent需要新增，添加插入effectTag 
    isHydrating = false; //停止hydrate，因为更新完这个节点会继续向下更新其子节点，该节点已经没有可以复用的节点，其子节点更不可能有可以复用的节点
    hydrationParentFiber = fiber;
    return;
  }
  const firstAttemptedInstance = nextInstance;
  if (!tryHydrate(fiber, nextInstance)) {  //服用节点失败
    // If we can't hydrate this instance let's try the next one.
    // We use this as a heuristic. It's based on intuition and not data so it
    // might be flawed or unnecessary.  --节点不能复用就考虑其兄弟节点是不是能服用--不是数据分析来的而是作为开发者认为这种情况可能存在--没有什么原理存在
    nextInstance = getNextHydratableSibling(firstAttemptedInstance); //寻找firstAttemptedInstance的合理兄弟节点
    if (!nextInstance || !tryHydrate(fiber, nextInstance)) { //合理的兄弟节点没找到或兄弟节点也复用失败
      // Nothing to hydrate. Make it an insertion.
      insertNonHydratedInstance((hydrationParentFiber: any), fiber); //该节点为新增，需增加插入effectTag
      isHydrating = false; //停止hydrate，因为节点已经不能复用
      hydrationParentFiber = fiber;
      return;
    }
    // We matched the next one, we'll now assume that the first one was
    // superfluous and we'll delete it. Since we can't eagerly delete it
    // we'll have to schedule a deletion. To do that, this node needs a dummy
    // fiber associated with it.
    deleteHydratableInstance( 
      (hydrationParentFiber: any),
      firstAttemptedInstance,
    );
  }
  hydrationParentFiber = fiber; 
  nextHydratableInstance = getFirstHydratableChild((nextInstance: any)); //复用成功继续向下找可以复用的子节点以便fiber.child复用
}

function prepareToHydrateHostInstance(
  fiber: Fiber,
  rootContainerInstance: Container,
  hostContext: HostContext,
): boolean {
  if (!supportsHydration) {
    invariant(
      false,
      'Expected prepareToHydrateHostInstance() to never be called. ' +
        'This error is likely caused by a bug in React. Please file an issue.',
    );
  }

  const instance: Instance = fiber.stateNode;
  const updatePayload = hydrateInstance(
    instance,
    fiber.type,
    fiber.memoizedProps,
    rootContainerInstance,
    hostContext,
    fiber,
  );
  // TODO: Type this specific to this type of component.
  fiber.updateQueue = (updatePayload: any);
  // If the update payload indicates that there is a change or if there
  // is a new ref we mark this as an update.
  if (updatePayload !== null) { 
    return true;  //有更新-》该节点需要更新
  }
  return false;
}

function prepareToHydrateHostTextInstance(fiber: Fiber): boolean {
  if (!supportsHydration) {
    invariant(
      false,
      'Expected prepareToHydrateHostTextInstance() to never be called. ' +
        'This error is likely caused by a bug in React. Please file an issue.',
    );
  }

  const textInstance: TextInstance = fiber.stateNode;
  const textContent: string = fiber.memoizedProps;
  const shouldUpdate = hydrateTextInstance(textInstance, textContent, fiber);
  if (__DEV__) {
    if (shouldUpdate) {
      // We assume that prepareToHydrateHostTextInstance is called in a context where the
      // hydration parent is the parent host component of this host text.
      const returnFiber = hydrationParentFiber;
      if (returnFiber !== null) {
        switch (returnFiber.tag) {
          case HostRoot: {
            const parentContainer = returnFiber.stateNode.containerInfo;
            didNotMatchHydratedContainerTextInstance(
              parentContainer,
              textInstance,
              textContent,
            );
            break;
          }
          case HostComponent: {
            const parentType = returnFiber.type;
            const parentProps = returnFiber.memoizedProps;
            const parentInstance = returnFiber.stateNode;
            didNotMatchHydratedTextInstance(
              parentType,
              parentProps,
              parentInstance,
              textInstance,
              textContent,
            );
            break;
          }
        }
      }
    }
  }
  return shouldUpdate;
}

function popToNextHostParent(fiber: Fiber): void {
  let parent = fiber.return;
  while (
    parent !== null &&
    parent.tag !== HostComponent &&
    parent.tag !== HostRoot
  ) {
    parent = parent.return;
  }
  hydrationParentFiber = parent;
}

function popHydrationState(fiber: Fiber): boolean {
  if (!supportsHydration) { //const supportsHydration = true常量
    return false;
  }
  if (fiber !== hydrationParentFiber) { //注意：存在复用失败，没有复用到一侧子树的最后子节点
    // We're deeper than the current hydration context, inside an inserted
    // tree.
    return false;
  }
  if (!isHydrating) { //父节点复用失败，基本不会进来因为上面就return了，除非是本身或其子节点复用失败才会走这个=》进入这个说明其父节点都是复用成功的，所以父节点completeWork时此值应为true
    // If we're not currently hydrating but we're in a hydration context, then
    // we were an insertion and now need to pop up reenter hydration of our
    // siblings.
    popToNextHostParent(fiber); //从fiber一层层往上找return为合理的节点(HostComponent、HostRoot)赋值给hydrationParentFiber
    isHydrating = true; //fiber对应节点复用失败，其return父节点复用成功，该节点完成completeWork后，其父节点completeWork阶段，复用成功所以此值为true
    return false;
  }

  const type = fiber.type;

  // If we have any remaining hydratable nodes, we need to delete them now.
  // We only do this deeper than head and body since they tend to have random
  // other nodes in them. We also ignore components with pure text content in
  // side of them.
  // TODO: Better heuristic.
  if (
    fiber.tag !== HostComponent ||
    (type !== 'head' &&
      type !== 'body' &&
      !shouldSetTextContent(type, fiber.memoizedProps)) //判断是否是input相关标签
  ) { //HostText
    let nextInstance = nextHydratableInstance; //更新的是文本节点，那么这个nextHydratableInstancede即文本节点的child，应该是null
    while (nextInstance) { //不是null=》不合理，需要删除
      deleteHydratableInstance(fiber, nextInstance); //删除节点
      nextInstance = getNextHydratableSibling(nextInstance); //寻找其合理的兄弟节点nextSibling
    }
  }

  popToNextHostParent(fiber); //上面执行完接下来要执行completeWork的就是其parent上的host节点，所以更改hydrationParentFiber为其父链上第一个合理的父节点
  nextHydratableInstance = hydrationParentFiber
    ? getNextHydratableSibling(fiber.stateNode) //该节点若有兄弟节点，再更新阶段有兄弟节点，这个执行完会去执行兄弟链上的beginWork
    : null; //null没有找到其父链上可以hydrate的父节点
  return true;
}

function resetHydrationState(): void {
  if (!supportsHydration) {
    return;
  }

  hydrationParentFiber = null;
  nextHydratableInstance = null;
  isHydrating = false;
}

export {
  enterHydrationState,
  resetHydrationState,
  tryToClaimNextHydratableInstance,
  prepareToHydrateHostInstance,
  prepareToHydrateHostTextInstance,
  popHydrationState,
};
