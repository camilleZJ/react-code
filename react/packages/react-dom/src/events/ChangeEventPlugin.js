/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as EventPluginHub from 'events/EventPluginHub';
import {accumulateTwoPhaseDispatches} from 'events/EventPropagators';
import {enqueueStateRestore} from 'events/ReactControlledComponent';
import {batchedUpdates} from 'events/ReactGenericBatching';
import SyntheticEvent from 'events/SyntheticEvent';
import isTextInputElement from 'shared/isTextInputElement';
import {canUseDOM} from 'shared/ExecutionEnvironment';

import {
  TOP_BLUR,
  TOP_CHANGE,
  TOP_CLICK,
  TOP_FOCUS,
  TOP_INPUT,
  TOP_KEY_DOWN,
  TOP_KEY_UP,
  TOP_SELECTION_CHANGE,
} from './DOMTopLevelEventTypes';
import getEventTarget from './getEventTarget';
import isEventSupported from './isEventSupported';
import {getNodeFromInstance} from '../client/ReactDOMComponentTree';
import * as inputValueTracking from '../client/inputValueTracking';
import {setDefaultValue} from '../client/ReactDOMInput';
import {disableInputAttributeSyncing} from 'shared/ReactFeatureFlags';

const eventTypes = {
  change: {
    phasedRegistrationNames: {
      bubbled: 'onChange',
      captured: 'onChangeCapture',
    },
    dependencies: [
      TOP_BLUR,
      TOP_CHANGE,
      TOP_CLICK,
      TOP_FOCUS,
      TOP_INPUT,
      TOP_KEY_DOWN,
      TOP_KEY_UP,
      TOP_SELECTION_CHANGE,
    ],
  },
};

function createAndAccumulateChangeEvent(inst, nativeEvent, target) {
  const event = SyntheticEvent.getPooled(  //react中的事件管理也是通过pool》减少对象声明会回收的开销
    eventTypes.change,
    inst,
    nativeEvent,
    target,
  );
  event.type = 'change';
  // Flag this event loop as needing state restore.
  enqueueStateRestore(target); //target加入restoreQueue，若setState后state对应的inputValue不一样了，需要把这个值进行回滚
  accumulateTwoPhaseDispatches(event);  //真正的从每个节点上获取listener的过程
  return event;
}
/**
 * For IE shims
 */
let activeElement = null;
let activeElementInst = null;

/**
 * SECTION: handle `change` event
 */
function shouldUseChangeEvent(elem) {
  const nodeName = elem.nodeName && elem.nodeName.toLowerCase();
  return (
    nodeName === 'select' || (nodeName === 'input' && elem.type === 'file')
  );
}

function manualDispatchChangeEvent(nativeEvent) {
  const event = createAndAccumulateChangeEvent(
    activeElementInst,
    nativeEvent,
    getEventTarget(nativeEvent),
  );

  // If change and propertychange bubbled, we'd just bind to it like all the
  // other events and have it go through ReactBrowserEventEmitter. Since it
  // doesn't, we manually listen for the events and so we have to enqueue and
  // process the abstract event manually.
  //
  // Batching is necessary here in order to ensure that all event handlers run
  // before the next rerender (including event handlers attached to ancestor
  // elements instead of directly on the input). Without this, controlled
  // components don't work properly in conjunction with event bubbling because
  // the component is rerendered and the value reverted before all the event
  // handlers can run. See https://github.com/facebook/react/issues/708.
  batchedUpdates(runEventInBatch, event);
}

function runEventInBatch(event) {
  EventPluginHub.runEventsInBatch(event, false);
}

function getInstIfValueChanged(targetInst) {
  const targetNode = getNodeFromInstance(targetInst); //targetNode = targetInst.stateNode
  if (inputValueTracking.updateValueIfChanged(targetNode)) {
    return targetInst;
  }
}

function getTargetInstForChangeEvent(topLevelType, targetInst) {
  if (topLevelType === TOP_CHANGE) {
    return targetInst;
  }
}

/**
 * SECTION: handle `input` event
 */
let isInputEventSupported = false;
if (canUseDOM) {
  // IE9 claims to support the input event but fails to trigger it when
  // deleting text, so we ignore its input events.
  isInputEventSupported =
    isEventSupported('input') &&
    (!document.documentMode || document.documentMode > 9);
}

/**
 * (For IE <=9) Starts tracking propertychange events on the passed-in element
 * and override the value property so that we can distinguish user events from
 * value changes in JS.
 */
function startWatchingForValueChange(target, targetInst) {
  activeElement = target;
  activeElementInst = targetInst;
  activeElement.attachEvent('onpropertychange', handlePropertyChange);
}

/**
 * (For IE <=9) Removes the event listeners from the currently-tracked element,
 * if any exists.
 */
function stopWatchingForValueChange() {
  if (!activeElement) {
    return;
  }
  activeElement.detachEvent('onpropertychange', handlePropertyChange);
  activeElement = null;
  activeElementInst = null;
}

/**
 * (For IE <=9) Handles a propertychange event, sending a `change` event if
 * the value of the active element has changed.
 */
function handlePropertyChange(nativeEvent) {
  if (nativeEvent.propertyName !== 'value') {
    return;
  }
  if (getInstIfValueChanged(activeElementInst)) {
    manualDispatchChangeEvent(nativeEvent);
  }
}

function handleEventsForInputEventPolyfill(topLevelType, target, targetInst) {
  if (topLevelType === TOP_FOCUS) {
    // In IE9, propertychange fires for most input events but is buggy and
    // doesn't fire when text is deleted, but conveniently, selectionchange
    // appears to fire in all of the remaining cases so we catch those and
    // forward the event if the value has changed
    // In either case, we don't want to call the event handler if the value
    // is changed from JS so we redefine a setter for `.value` that updates
    // our activeElementValue variable, allowing us to ignore those changes
    //
    // stopWatching() should be a noop here but we call it just in case we
    // missed a blur event somehow.
    stopWatchingForValueChange();
    startWatchingForValueChange(target, targetInst);
  } else if (topLevelType === TOP_BLUR) {
    stopWatchingForValueChange();
  }
}

// For IE8 and IE9.
function getTargetInstForInputEventPolyfill(topLevelType, targetInst) {
  if (
    topLevelType === TOP_SELECTION_CHANGE ||
    topLevelType === TOP_KEY_UP ||
    topLevelType === TOP_KEY_DOWN
  ) {
    // On the selectionchange event, the target is just document which isn't
    // helpful for us so just check activeElement instead.
    //
    // 99% of the time, keydown and keyup aren't necessary. IE8 fails to fire
    // propertychange on the first input event after setting `value` from a
    // script and fires only keydown, keypress, keyup. Catching keyup usually
    // gets it and catching keydown lets us fire an event for the first
    // keystroke if user does a key repeat (it'll be a little delayed: right
    // before the second keystroke). Other input methods (e.g., paste) seem to
    // fire selectionchange normally.
    return getInstIfValueChanged(activeElementInst);
  }
}

/**
 * SECTION: handle `click` event
 */
function shouldUseClickEvent(elem) {
  // Use the `click` event to detect changes to checkbox and radio inputs.
  // This approach works across all browsers, whereas `change` does not fire
  // until `blur` in IE8.
  const nodeName = elem.nodeName;
  return (
    nodeName &&
    nodeName.toLowerCase() === 'input' &&
    (elem.type === 'checkbox' || elem.type === 'radio')
  );
}

function getTargetInstForClickEvent(topLevelType, targetInst) {
  if (topLevelType === TOP_CLICK) {
    return getInstIfValueChanged(targetInst);
  }
}

function getTargetInstForInputOrChangeEvent(topLevelType, targetInst) {
  if (topLevelType === TOP_INPUT || topLevelType === TOP_CHANGE) {
    return getInstIfValueChanged(targetInst);
  }
}

function handleControlledInputBlur(node) {
  let state = node._wrapperState;

  if (!state || !state.controlled || node.type !== 'number') {
    return;
  }

  if (!disableInputAttributeSyncing) {
    // If controlled, assign the value attribute to the current value on blur
    setDefaultValue(node, 'number', node.value);
  }
}

/**
 * This plugin creates an `onChange` event that normalizes change events
 * across form elements. This event fires at a time when it's possible to
 * change the element's value without seeing a flicker.
 *
 * Supported elements are:
 * - input (see `isTextInputElement`)
 * - textarea
 * - select
 */
const ChangeEventPlugin = {
  eventTypes: eventTypes,

  _isInputEventSupported: isInputEventSupported,

  extractEvents: function(
    topLevelType,
    targetInst,
    nativeEvent,
    nativeEventTarget,
  ) {
    const targetNode = targetInst ? getNodeFromInstance(targetInst) : window;  //传进来的targetInst是fiber对象，获取其对应的node节点：targetInst.stateNode

    //react中的onChange事件封装了不同的事件(dependencies)，不同的标签类型只能绑定指定的事件，如type为file的input或select标签是直接需要changeEvent的，像是type为text的input若想要用户输入的时候react中的value实时变化应该绑定的是inputEvent，也可以绑定change
    let getTargetInstFunc, handleEventFunc;
    if (shouldUseChangeEvent(targetNode)) {  //targetNode.nodeName为type为file的input或select：只能绑定change事件
      getTargetInstFunc = getTargetInstForChangeEvent;  //绑定的是change=》return targetInst
    } else if (isTextInputElement(targetNode)) { //targetNode.nodeName为指定类型数组内的某一type的input或textarea："input" || "change"都可以
      if (isInputEventSupported) {  //支持input事件检验：对于浏览器来说是支持的
        getTargetInstFunc = getTargetInstForInputOrChangeEvent;  //绑定的使"input" || "change"事件=》return getInstIfValueChanged(targetInst);
      } else { //使平台支持input事件的pollyfill
        getTargetInstFunc = getTargetInstForInputEventPolyfill;
        handleEventFunc = handleEventsForInputEventPolyfill;
      }
    } else if (shouldUseClickEvent(targetNode)) { //type为checkbox或radio的input=》click事件
      getTargetInstFunc = getTargetInstForClickEvent;  //绑定的是click事件=》return getInstIfValueChanged(targetInst);
    }  

    if (getTargetInstFunc) { //input、change、click事件
      const inst = getTargetInstFunc(topLevelType, targetInst);  //执行上面的方法，不能标签指定的绑定事件才会执行
      if (inst) {  //只有返回inst的才能创建事件
        const event = createAndAccumulateChangeEvent( //创建事件
          inst, //targetInst
          nativeEvent,
          nativeEventTarget,
        );
        return event;
      }
    }

    if (handleEventFunc) {
      handleEventFunc(topLevelType, targetNode, targetInst);
    }

    // When blurring, set the value attribute for number inputs
    if (topLevelType === TOP_BLUR) {  //blur事件
      handleControlledInputBlur(targetNode);
    }
  },
};

export default ChangeEventPlugin;
