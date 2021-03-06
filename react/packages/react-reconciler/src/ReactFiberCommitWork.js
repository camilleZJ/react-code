/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {
  Instance,
  TextInstance,
  Container,
  ChildSet,
  UpdatePayload,
} from './ReactFiberHostConfig';
import type {Fiber} from './ReactFiber';
import type {FiberRoot} from './ReactFiberRoot';
import type {ExpirationTime} from './ReactFiberExpirationTime';
import type {CapturedValue, CapturedError} from './ReactCapturedValue';
import type {SuspenseState} from './ReactFiberSuspenseComponent';

import {
  enableSchedulerTracing,
  enableProfilerTimer,
} from 'shared/ReactFeatureFlags';
import {
  ClassComponent,
  HostRoot,
  HostComponent,
  HostText,
  HostPortal,
  Profiler,
  SuspenseComponent,
  IncompleteClassComponent,
} from 'shared/ReactWorkTags';
import {
  invokeGuardedCallback,
  hasCaughtError,
  clearCaughtError,
} from 'shared/ReactErrorUtils';
import {
  ContentReset,
  Placement,
  Snapshot,
  Update,
  Callback,
} from 'shared/ReactSideEffectTags';
import getComponentName from 'shared/getComponentName';
import invariant from 'shared/invariant';
import warningWithoutStack from 'shared/warningWithoutStack';

import {NoWork, Sync} from './ReactFiberExpirationTime';
import {onCommitUnmount} from './ReactFiberDevToolsHook';
import {startPhaseTimer, stopPhaseTimer} from './ReactDebugFiberPerf';
import {getStackByFiberInDevAndProd} from './ReactCurrentFiber';
import {logCapturedError} from './ReactFiberErrorLogger';
import {getCommitTime} from './ReactProfilerTimer';
import {commitUpdateQueue} from './ReactUpdateQueue';
import {
  getPublicInstance,
  supportsMutation,
  supportsPersistence,
  commitMount,
  commitUpdate,
  resetTextContent,
  commitTextUpdate,
  appendChild,
  appendChildToContainer,
  insertBefore,
  insertInContainerBefore,
  removeChild,
  removeChildFromContainer,
  replaceContainerChildren,
  createContainerChildSet,
  hideInstance,
  hideTextInstance,
  unhideInstance,
  unhideTextInstance,
} from './ReactFiberHostConfig';
import {
  captureCommitPhaseError,
  requestCurrentTime,
  scheduleWork,
} from './ReactFiberScheduler';

let didWarnAboutUndefinedSnapshotBeforeUpdate: Set<mixed> | null = null;
if (__DEV__) {
  didWarnAboutUndefinedSnapshotBeforeUpdate = new Set();
}

export function logError(boundary: Fiber, errorInfo: CapturedValue<mixed>) {
  const source = errorInfo.source;
  let stack = errorInfo.stack;
  if (stack === null && source !== null) {
    stack = getStackByFiberInDevAndProd(source);
  }

  const capturedError: CapturedError = {
    componentName: source !== null ? getComponentName(source.type) : null,
    componentStack: stack !== null ? stack : '',
    error: errorInfo.value,
    errorBoundary: null,
    errorBoundaryName: null,
    errorBoundaryFound: false,
    willRetry: false,
  };

  if (boundary !== null && boundary.tag === ClassComponent) {
    capturedError.errorBoundary = boundary.stateNode;
    capturedError.errorBoundaryName = getComponentName(boundary.type);
    capturedError.errorBoundaryFound = true;
    capturedError.willRetry = true;
  }

  try {
    logCapturedError(capturedError);
  } catch (e) {
    // This method must not throw, or React internal state will get messed up.
    // If console.error is overridden, or logCapturedError() shows a dialog that throws,
    // we want to report this error outside of the normal stack as a last resort.
    // https://github.com/facebook/react/issues/13188
    setTimeout(() => {
      throw e;
    });
  }
}

const callComponentWillUnmountWithTimer = function(current, instance) {
  startPhaseTimer(current, 'componentWillUnmount');
  instance.props = current.memoizedProps;
  instance.state = current.memoizedState;
  instance.componentWillUnmount();
  stopPhaseTimer();
};

// Capture errors so they don't interrupt unmounting.
function safelyCallComponentWillUnmount(current, instance) {
  if (__DEV__) {
    invokeGuardedCallback(
      null,
      callComponentWillUnmountWithTimer,
      null,
      current,
      instance,
    );
    if (hasCaughtError()) {
      const unmountError = clearCaughtError();
      captureCommitPhaseError(current, unmountError);
    }
  } else {
    try {
      callComponentWillUnmountWithTimer(current, instance);
    } catch (unmountError) {
      captureCommitPhaseError(current, unmountError);
    }
  }
}

function safelyDetachRef(current: Fiber) {
  const ref = current.ref;
  if (ref !== null) {
    if (typeof ref === 'function') {
      if (__DEV__) {
        invokeGuardedCallback(null, ref, null, null);
        if (hasCaughtError()) {
          const refError = clearCaughtError();
          captureCommitPhaseError(current, refError);
        }
      } else {
        try {
          ref(null);
        } catch (refError) {
          captureCommitPhaseError(current, refError);
        }
      }
    } else {
      ref.current = null;
    }
  }
}

function commitBeforeMutationLifeCycles(
  current: Fiber | null,
  finishedWork: Fiber,
): void {
  switch (finishedWork.tag) {
    case ClassComponent: {
      if (finishedWork.effectTag & Snapshot) {
        if (current !== null) {
          const prevProps = current.memoizedProps;
          const prevState = current.memoizedState;
          startPhaseTimer(finishedWork, 'getSnapshotBeforeUpdate');
          const instance = finishedWork.stateNode;
          instance.props = finishedWork.memoizedProps;
          instance.state = finishedWork.memoizedState;
          const snapshot = instance.getSnapshotBeforeUpdate(
            prevProps,
            prevState,
          );
          if (__DEV__) {
            const didWarnSet = ((didWarnAboutUndefinedSnapshotBeforeUpdate: any): Set<
              mixed,
            >);
            if (snapshot === undefined && !didWarnSet.has(finishedWork.type)) {
              didWarnSet.add(finishedWork.type);
              warningWithoutStack(
                false,
                '%s.getSnapshotBeforeUpdate(): A snapshot value (or null) ' +
                  'must be returned. You have returned undefined.',
                getComponentName(finishedWork.type),
              );
            }
          }
          instance.__reactInternalSnapshotBeforeUpdate = snapshot; //把快照挂载到instance上，之后通过instance获取可以进行对比
          stopPhaseTimer();
        }
      }
      return;
    }
    case HostRoot:
    case HostComponent:
    case HostText:
    case HostPortal:
    case IncompleteClassComponent:
      // Nothing to do for these component types
      return;
    default: {
      invariant(
        false,
        'This unit of work tag should not have side-effects. This error is ' +
          'likely caused by a bug in React. Please file an issue.',
      );
    }
  }
}

function commitLifeCycles(
  finishedRoot: FiberRoot,
  current: Fiber | null,
  finishedWork: Fiber,
  committedExpirationTime: ExpirationTime,
): void {
  switch (finishedWork.tag) {
    case ClassComponent: {
      const instance = finishedWork.stateNode;
      if (finishedWork.effectTag & Update) {
        if (current === null) {
          startPhaseTimer(finishedWork, 'componentDidMount');
          instance.props = finishedWork.memoizedProps;
          instance.state = finishedWork.memoizedState;
          instance.componentDidMount();
          stopPhaseTimer();
        } else {
          const prevProps = current.memoizedProps;
          const prevState = current.memoizedState;
          startPhaseTimer(finishedWork, 'componentDidUpdate');
          instance.props = finishedWork.memoizedProps;
          instance.state = finishedWork.memoizedState;
          instance.componentDidUpdate(
            prevProps,
            prevState,
            instance.__reactInternalSnapshotBeforeUpdate,  //commitRoot第一个循环生成的快照
          );
          stopPhaseTimer();
        }
      }
      const updateQueue = finishedWork.updateQueue;
      if (updateQueue !== null) {
        instance.props = finishedWork.memoizedProps;
        instance.state = finishedWork.memoizedState;
        commitUpdateQueue(
          finishedWork,
          updateQueue,
          instance,
          committedExpirationTime,
        );
      }
      return;
    }
    case HostRoot: {
      const updateQueue = finishedWork.updateQueue; //只有reactDom.render时才会创建update
      if (updateQueue !== null) {
        let instance = null;
        if (finishedWork.child !== null) {
          switch (finishedWork.child.tag) {
            case HostComponent: //instance就是HostComponent的dom节点
              instance = getPublicInstance(finishedWork.child.stateNode); // 获取全局变量：return instance;
              break;
            case ClassComponent:
              instance = finishedWork.child.stateNode;
              break;
          }
        }
        commitUpdateQueue( //和上面一样执行updateQueue中的callback
          finishedWork,
          updateQueue,
          instance,
          committedExpirationTime,
        );
      }
      return;
    }
    case HostComponent: {
      const instance: Instance = finishedWork.stateNode;

      // Renderers may schedule work to be done after host components are mounted
      // (eg DOM renderer may schedule auto-focus for inputs and form controls).
      // These effects should only be committed when components are first mounted,
      // aka when there is no current/alternate.
      if (current === null && finishedWork.effectTag & Update) { //获取焦点处理前提是current === null也就是只有初次渲染的时候才会获取焦点
        const type = finishedWork.type;
        const props = finishedWork.memoizedProps;
        commitMount(instance, type, props, finishedWork); //对于input、select、button、textarea设置了autoFocus，就focus获取焦点
      }

      return;
    }
    case HostText: {
      // We have no life-cycles associated with text.
      return;
    }
    case HostPortal: {
      // We have no life-cycles associated with portals.
      return;
    }
    case Profiler: {
      if (enableProfilerTimer) {
        const onRender = finishedWork.memoizedProps.onRender;

        if (enableSchedulerTracing) {
          onRender(
            finishedWork.memoizedProps.id,
            current === null ? 'mount' : 'update',
            finishedWork.actualDuration,
            finishedWork.treeBaseDuration,
            finishedWork.actualStartTime,
            getCommitTime(),
            finishedRoot.memoizedInteractions,
          );
        } else {
          onRender(
            finishedWork.memoizedProps.id,
            current === null ? 'mount' : 'update',
            finishedWork.actualDuration,
            finishedWork.treeBaseDuration,
            finishedWork.actualStartTime,
            getCommitTime(),
          );
        }
      }
      return;
    }
    case SuspenseComponent: {
      if (finishedWork.effectTag & Callback) {
        // In non-strict mode, a suspense boundary times out by commiting
        // twice: first, by committing the children in an inconsistent state,
        // then hiding them and showing the fallback children in a subsequent
        // commit.
        const newState: SuspenseState = {
          alreadyCaptured: true,
          didTimeout: false,
          timedOutAt: NoWork,
        };
        finishedWork.memoizedState = newState;
        scheduleWork(finishedWork, Sync);
        return;
      }
      let oldState: SuspenseState | null =
        current !== null ? current.memoizedState : null;
      let newState: SuspenseState | null = finishedWork.memoizedState;
      let oldDidTimeout = oldState !== null ? oldState.didTimeout : false;

      let newDidTimeout;
      let primaryChildParent = finishedWork;
      if (newState === null) {
        newDidTimeout = false;
      } else {
        newDidTimeout = newState.didTimeout;
        if (newDidTimeout) {
          primaryChildParent = finishedWork.child;
          newState.alreadyCaptured = false;
          if (newState.timedOutAt === NoWork) {
            // If the children had not already timed out, record the time.
            // This is used to compute the elapsed time during subsequent
            // attempts to render the children.
            newState.timedOutAt = requestCurrentTime();
          }
        }
      }

      if (newDidTimeout !== oldDidTimeout && primaryChildParent !== null) {
        hideOrUnhideAllChildren(primaryChildParent, newDidTimeout);
      }
      return;
    }
    case IncompleteClassComponent:
      break;
    default: {
      invariant(
        false,
        'This unit of work tag should not have side-effects. This error is ' +
          'likely caused by a bug in React. Please file an issue.',
      );
    }
  }
}

function hideOrUnhideAllChildren(finishedWork, isHidden) {
  if (supportsMutation) {
    // We only have the top Fiber that was inserted but we need recurse down its
    // children to find all the terminal nodes.
    let node: Fiber = finishedWork;
    while (true) {
      if (node.tag === HostComponent) {
        const instance = node.stateNode;
        if (isHidden) {
          hideInstance(instance);
        } else {
          unhideInstance(node.stateNode, node.memoizedProps);
        }
      } else if (node.tag === HostText) {
        const instance = node.stateNode;
        if (isHidden) {
          hideTextInstance(instance);
        } else {
          unhideTextInstance(instance, node.memoizedProps);
        }
      } else if (node.child !== null) {
        node.child.return = node;
        node = node.child;
        continue;
      }
      if (node === finishedWork) {
        return;
      }
      while (node.sibling === null) {
        if (node.return === null || node.return === finishedWork) {
          return;
        }
        node = node.return;
      }
      node.sibling.return = node.return;
      node = node.sibling;
    }
  }
}

function commitAttachRef(finishedWork: Fiber) {
  const ref = finishedWork.ref;
  if (ref !== null) {
    const instance = finishedWork.stateNode;
    let instanceToUse;
    switch (finishedWork.tag) {
      case HostComponent:
        instanceToUse = getPublicInstance(instance); //return instance，tag=HostComponent即dom节点对应的实例
        break;
      default:
        instanceToUse = instance;
    }
    if (typeof ref === 'function') {
      ref(instanceToUse); //函数式ref直接执行这个函数，dom实例作为参数
    } else {
      if (__DEV__) {
        if (!ref.hasOwnProperty('current')) {
          warningWithoutStack(
            false,
            'Unexpected ref object provided for %s. ' +
              'Use either a ref-setter function or React.createRef().%s',
            getComponentName(finishedWork.type),
            getStackByFiberInDevAndProd(finishedWork),
          );
        }
      }

      ref.current = instanceToUse; //object式ref设置对象的current值
    }
  }
}

function commitDetachRef(current: Fiber) {
  const currentRef = current.ref; 
  if (currentRef !== null) { //detach 卸载ref
    if (typeof currentRef === 'function') {
      currentRef(null); //函数式ref直接调用value置为null
    } else {
      currentRef.current = null; //object式ref直接使对象中的current为null
    }
  }
}

// User-originating errors (lifecycles and refs) should not interrupt
// deletion, so don't let them throw. Host-originating errors should
// interrupt deletion, so it's okay
function commitUnmount(current: Fiber): void {
  onCommitUnmount(current);

  switch (current.tag) {
    case ClassComponent: {
      safelyDetachRef(current); //卸载ref
      const instance = current.stateNode;
      if (typeof instance.componentWillUnmount === 'function') {
        safelyCallComponentWillUnmount(current, instance); //调用声明周期方法：ComponentWillUnmount
      }
      return;
    }
    case HostComponent: {
      safelyDetachRef(current);  //卸载ref
      return;
    }
    case HostPortal: {
      // TODO: this is recursive.
      // We are also not using this parent because
      // the portal will get pushed immediately.
      if (supportsMutation) {
        unmountHostComponents(current); //又递归回去了
      } else if (supportsPersistence) {
        emptyPortalContainer(current);
      }
      return;
    }
  }
}

function commitNestedUnmounts(root: Fiber): void {
  // While we're inside a removed host node we don't want to call
  // removeChild on the inner nodes because they're removed by the top
  // call anyway. We also want to call componentWillUnmount on all
  // composites before this host node is removed from the tree. Therefore
  // we do an inner loop while we're still inside the host node.
  let node: Fiber = root;
  while (true) {  //从node开始遍历node及node以下子树child，下面的sibling是node以下这个子树种有分叉子树，就是对node开始的这棵树遍历所有节点都去执行commitUnmount
    commitUnmount(node); //卸载ref、执行生命周期函数ComponentWillUnmount等操作
    // Visit children because they may contain more composite or host nodes.
    // Skip portals because commitUnmount() currently visits them recursively.
    if (
      node.child !== null &&
      // If we use mutation we drill down into portals using commitUnmount above.
      // If we don't use mutation we drill down into portals here instead.
      (!supportsMutation || node.tag !== HostPortal)
    ) { //此循环中root子树中可能有Portal节点：对于该节点执行commitUnmount，不满足该if条件即child处理是在commitUnmount中Portal节点递归调用了unmountHostComponents处理child，Portal组件不在此处处理child但是以下的非Portal的sibling还是会处理的
      node.child.return = node;
      node = node.child;
      continue;
    }
    if (node === root) {
      return;
    }
    while (node.sibling === null) {
      if (node.return === null || node.return === root) {
        return;
      }
      node = node.return;
    }
    node.sibling.return = node.return;
    node = node.sibling;
  }
}

function detachFiber(current: Fiber) {
  // Cut off the return pointers to disconnect it from the tree. Ideally, we
  // should clear the child pointer of the parent alternate to let this
  // get GC:ed but we don't know which for sure which parent is the current
  // one so we'll settle for GC:ing the subtree of this child. This child
  // itself will be GC:ed when the parent updates the next time.
  current.return = null;
  current.child = null;
  if (current.alternate) {
    current.alternate.child = null;
    current.alternate.return = null;
  }
}

function emptyPortalContainer(current: Fiber) {
  if (!supportsPersistence) {
    return;
  }

  const portal: {containerInfo: Container, pendingChildren: ChildSet} =
    current.stateNode;
  const {containerInfo} = portal;
  const emptyChildSet = createContainerChildSet(containerInfo);
  replaceContainerChildren(containerInfo, emptyChildSet);
}

function commitContainer(finishedWork: Fiber) {
  if (!supportsPersistence) {
    return;
  }

  switch (finishedWork.tag) {
    case ClassComponent: {
      return;
    }
    case HostComponent: {
      return;
    }
    case HostText: {
      return;
    }
    case HostRoot:
    case HostPortal: {
      const portalOrRoot: {
        containerInfo: Container,
        pendingChildren: ChildSet,
      } =
        finishedWork.stateNode;
      const {containerInfo, pendingChildren} = portalOrRoot;
      replaceContainerChildren(containerInfo, pendingChildren);
      return;
    }
    default: {
      invariant(
        false,
        'This unit of work tag should not have side-effects. This error is ' +
          'likely caused by a bug in React. Please file an issue.',
      );
    }
  }
}

function getHostParentFiber(fiber: Fiber): Fiber {
  let parent = fiber.return;
  while (parent !== null) {
    if (isHostParent(parent)) {
      return parent;
    }
    parent = parent.return;
  }
  invariant(
    false,
    'Expected to find a host parent. This error is likely caused by a bug ' +
      'in React. Please file an issue.',
  );
}

function isHostParent(fiber: Fiber): boolean {
  return (
    fiber.tag === HostComponent ||
    fiber.tag === HostRoot ||
    fiber.tag === HostPortal
  );
}

function getHostSibling(fiber: Fiber): ?Instance {  //获取before，并不是要插入位置前面的那个节点，而是找在哪个节点之前插入即insertBefore，而且找的是子节点中第一个dom节点，即找的是在哪个dom（hostComponent、text节点）之前插入
  // We're going to search forward into the tree until we find a sibling host
  // node. Unfortunately, if multiple insertions are done in a row we have to
  // search past them. This leads to exponential search for the next sibling.
  // TODO: Find a more efficient way to do this.
  let node: Fiber = fiber;
  siblings: while (true) {
    // If we didn't find anything, let's try the next sibling.
    while (node.sibling === null) { //找其sibling，若是没有就向上找父元素的sibling
      if (node.return === null || isHostParent(node.return)) {
        // If we pop out of the root or hit the parent the fiber we are the
        // last sibling.
        return null;
      }
      node = node.return;
    }
    node.sibling.return = node.return;
    node = node.sibling; //node有sibling，就取出sibling
    //此循环只是在其sibling兄弟节点树中找第一个dom（HostComponent、HostText）且没有Placement effectTag的节点
    while (node.tag !== HostComponent && node.tag !== HostText) { //不是需要真正渲染的节点（需要插入dom操作的节点），最终真正渲染的只有：HostComponent、HostText
      // If it is not host node and, we might have a host node inside it.
      // Try to search down until we find one.
      if (node.effectTag & Placement) {
        // If we don't have a child, try the siblings instead.
        continue siblings;
      }
      // If we don't have a child, try the siblings instead.
      // We also skip portals because they are not part of this host tree.
      if (node.child === null || node.tag === HostPortal) { //HostPortal的内容不能作为子元素这部分内容是需要插入到portal容器中的
        continue siblings;
      } else {
        node.child.return = node;
        node = node.child; //从sibling子树中向下找child
      }
    }
    // Check if this host node is stable or about to be placed.
    if (!(node.effectTag & Placement)) {
      // Found it!
      return node.stateNode;
    }
  }
}

function commitPlacement(finishedWork: Fiber): void {
  if (!supportsMutation) { //react dom下supportsMutation=true不会进入
    return;
  }

  // Recursively insert all host nodes into the parent.
  const parentFiber = getHostParentFiber(finishedWork);//从当前节点开始一层层取return父元素，返回第一个父节点为fiber.tag=HostComponent || HostRoot || HostPortal

  // Note: these two variables *must* always be updated together.
  let parent;
  let isContainer;

  switch (parentFiber.tag) {
    case HostComponent:
      parent = parentFiber.stateNode; //容器dom节点
      isContainer = false;
      break;
    case HostRoot:
      parent = parentFiber.stateNode.containerInfo; //对应的container dom节点
      isContainer = true;
      break;
    case HostPortal:
      parent = parentFiber.stateNode.containerInfo;
      isContainer = true;
      break;
    default:
      invariant(
        false,
        'Invalid host parent fiber. This error is likely caused by a bug ' +
          'in React. Please file an issue.',
      );
  }
  if (parentFiber.effectTag & ContentReset) { //文本节点更新之前reset文本内容
    // Reset the text content of the parent before doing any insertions
    resetTextContent(parent);
    // Clear ContentReset from the effect tag
    parentFiber.effectTag &= ~ContentReset;
  }

  const before = getHostSibling(finishedWork); //其子树或没有子树向上找第一个父级的子树中遍历child找到第一个dom（HostComponent、HostText）且没有Placement effectTag的节点，若是单个节点可能没有before即为null，祖师before不是fiber对象了而是fiber.stateNode
  // We only have the top Fiber that was inserted but we need recurse down its
  // children to find all the terminal nodes.
  let node: Fiber = finishedWork;
  while (true) {
    if (node.tag === HostComponent || node.tag === HostText) { //只有这两种情况需要真正插入dom
      if (before) {
        if (isContainer) {
          insertInContainerBefore(parent, node.stateNode, before);  //与下面区别就是排除注释节点，注释节点的话父元素取其parentNode：(parent.parentNode).insertBefore(node.stateNode, before)
        } else {
          insertBefore(parent, node.stateNode, before); //parent.insertBefore(node.stateNode, before)
        }
      } else { //单个节点采用appendChild
        if (isContainer) {
          appendChildToContainer(parent, node.stateNode); //判断parent.nodeType是否为COMMENT_NODE，是-取parentNode并调用insertBefore，将node.stateNode插入到注释节点之前
        } else {
          appendChild(parent, node.stateNode); //parent。appendChild(node.stateNode)
        }
      }
    } else if (node.tag === HostPortal) { //这个是要插入到portal容器内的而不是root中，所以此处不需要处理其children
      // If the insertion itself is a portal, then we don't want to traverse
      // down its children. Instead, we'll get insertions from each child in
      // the portal directly.
    } else if (node.child !== null) {  //把子树的所有节点都进行插入操作
      node.child.return = node;
      node = node.child; //不是正真需要插入的节点就向下遍历child，需要插入的执行插入操作，不需要的就跳过向下遍历
      continue;
    }
    if (node === finishedWork) { //没有child，单个节点处理完成
      return;
    } 
    while (node.sibling === null) { //classComponent插入子节点，子节点可能是一个数组，数组中都是sibling，对于这些sibling也需要插入节点操作
      if (node.return === null || node.return === finishedWork) {
        return;
      }
      node = node.return;
    }
    node.sibling.return = node.return;
    node = node.sibling;
  }
}

function unmountHostComponents(current): void {
  // We only have the top Fiber that was deleted but we need recurse down its
  // children to find all the terminal nodes.
  let node: Fiber = current;

  // Each iteration, currentParent is populated with node's host parent if not
  // currentParentIsValid.
  let currentParentIsValid = false;

  // Note: these two variables *must* always be updated together.
  let currentParent;
  let currentParentIsContainer;

  while (true) {
    if (!currentParentIsValid) {
      let parent = node.return;
      findParent: while (true) { //第一个while循环找ParentContainer
        invariant(
          parent !== null,
          'Expected to find a host parent. This error is likely caused by ' +
            'a bug in React. Please file an issue.',
        );
        switch (parent.tag) {
          case HostComponent:
            currentParent = parent.stateNode;
            currentParentIsContainer = false;
            break findParent;
          case HostRoot:
            currentParent = parent.stateNode.containerInfo;
            currentParentIsContainer = true;
            break findParent;
          case HostPortal:
            currentParent = parent.stateNode.containerInfo;
            currentParentIsContainer = true;
            break findParent;
        }
        parent = parent.return;
      }
      currentParentIsValid = true;
    }

    //深度优先遍历算法
    if (node.tag === HostComponent || node.tag === HostText) { //真正需要操作DOM的节点
      commitNestedUnmounts(node);
      // After all the children have unmounted, it is now safe to remove the
      // node from the tree.
      if (currentParentIsContainer) { //从node开始整颗子树都可以删除处理
        removeChildFromContainer((currentParent: any), node.stateNode); //从父节点内部删除子节点
      } else {
        removeChild((currentParent: any), node.stateNode); //直接删除父节点
      }
      // Don't visit children because we already visited them.
    } else if (node.tag === HostPortal) {
      // When we go into a portal, it becomes the parent to remove from.
      // We will reassign it back when we pop the portal on the way up.
      currentParent = node.stateNode.containerInfo;
      currentParentIsContainer = true;
      // Visit children because portals might contain host components.
      if (node.child !== null) {
        node.child.return = node;
        node = node.child;
        continue;
      }
    } else {
      commitUnmount(node);
      // Visit children because we may find more host components below.
      if (node.child !== null) {
        node.child.return = node;
        node = node.child;
        continue;
      }
    }
    if (node === current) {  //遍历子树，若是又回来node=current说明遍历完了
      return;
    }  //此if和下面的循环意思：从node开始处理，若是node.tag类型为操作DOM的类型：处理整棵树-满足if跳出 ，若不是遍历node这个子树，不会遇到这个if处理node以下节点包括这个节点以下还有的子树-下面的while循环，整棵树遍历完成又会回到node，此时return跳出循环
    while (node.sibling === null) { //一侧子树遍历完成，才会遍历另一个子树sibling
      if (node.return === null || node.return === current) {
        return;
      }
      node = node.return; //不断向上找sibling，直到node === current跳出循环
      if (node.tag === HostPortal) {
        // When we go out of the portal, we need to restore the parent.
        // Since we don't keep a stack of them, we will search for it.
        currentParentIsValid = false;
      }
    }
    node.sibling.return = node.return;
    node = node.sibling;
  }
}

function commitDeletion(current: Fiber): void {
  if (supportsMutation) { //react dom走这个
    // Recursively delete all host nodes from the parent.
    // Detach refs and call componentWillUnmount() on the whole subtree.
    unmountHostComponents(current);
  } else {
    // Detach refs and call componentWillUnmount() on the whole subtree.
    commitNestedUnmounts(current);
  }
  detachFiber(current);
}

function commitWork(current: Fiber | null, finishedWork: Fiber): void {
  if (!supportsMutation) { //react dom下supportsMutation=true不会进来
    commitContainer(finishedWork);
    return;
  }

  switch (finishedWork.tag) {
    case ClassComponent: {
      return;
    }
    case HostComponent: { //和dom操作相关的之后两种类型的tag：HostComponent、HostText
      const instance: Instance = finishedWork.stateNode; //completeWork阶段创建的dom元素
      if (instance != null) {
        // Commit the work prepared earlier.
        const newProps = finishedWork.memoizedProps;
        // For hydration we reuse the update path but we treat the oldProps
        // as the newProps. The updatePayload will contain the real change in
        // this case.
        const oldProps = current !== null ? current.memoizedProps : newProps;
        const type = finishedWork.type;
        // TODO: Type the updateQueue to be specific to host components.
        const updatePayload: null | UpdatePayload = (finishedWork.updateQueue: any); //completeWork阶段:workInProgress.updateQueue = updatePayload（updatePayload=prepareUpdate(...)对比新旧属性，按照key如style等属性存如的数组）
        finishedWork.updateQueue = null;
        if (updatePayload !== null) {
          commitUpdate(
            instance,
            updatePayload,
            type,
            oldProps,
            newProps,
            finishedWork,
          );
        }
      }
      return;
    }
    case HostText: {
      invariant(
        finishedWork.stateNode !== null,
        'This should have a text node initialized. This error is likely ' +
          'caused by a bug in React. Please file an issue.',
      );
      const textInstance: TextInstance = finishedWork.stateNode;
      const newText: string = finishedWork.memoizedProps;
      // For hydration we reuse the update path but we treat the oldProps
      // as the newProps. The updatePayload will contain the real change in
      // this case.
      const oldText: string =
        current !== null ? current.memoizedProps : newText;
      commitTextUpdate(textInstance, oldText, newText);
      return;
    }
    case HostRoot: {
      return;
    }
    case Profiler: {
      return;
    }
    case SuspenseComponent: {
      return;
    }
    case IncompleteClassComponent: {
      return;
    }
    default: {
      invariant(
        false,
        'This unit of work tag should not have side-effects. This error is ' +
          'likely caused by a bug in React. Please file an issue.',
      );
    }
  }
}

function commitResetTextContent(current: Fiber) {
  if (!supportsMutation) { //reactDom下supportsMutation=true，不会进来
    return;
  }
  resetTextContent(current.stateNode);
}

export {
  commitBeforeMutationLifeCycles,
  commitResetTextContent,
  commitPlacement,
  commitDeletion,
  commitWork,
  commitLifeCycles,
  commitAttachRef,
  commitDetachRef,
};
