/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import {registrationNameDependencies} from 'events/EventPluginRegistry';
import {
  TOP_BLUR,
  TOP_CANCEL,
  TOP_CLOSE,
  TOP_FOCUS,
  TOP_INVALID,
  TOP_RESET,
  TOP_SCROLL,
  TOP_SUBMIT,
  getRawEventName,
  mediaEventTypes,
} from './DOMTopLevelEventTypes';
import {
  setEnabled,
  isEnabled,
  trapBubbledEvent,
  trapCapturedEvent,
} from './ReactDOMEventListener';
import isEventSupported from './isEventSupported';

/**
 * Summary of `ReactBrowserEventEmitter` event handling:
 *
 *  - Top-level delegation is used to trap most native browser events. This
 *    may only occur in the main thread and is the responsibility of
 *    ReactDOMEventListener, which is injected and can therefore support
 *    pluggable event sources. This is the only work that occurs in the main
 *    thread.
 *
 *  - We normalize and de-duplicate events to account for browser quirks. This
 *    may be done in the worker thread.
 *
 *  - Forward these native events (with the associated top-level type used to
 *    trap it) to `EventPluginHub`, which in turn will ask plugins if they want
 *    to extract any synthetic events.
 *
 *  - The `EventPluginHub` will then process each event by annotating them with
 *    "dispatches", a sequence of listeners and IDs that care about that event.
 *
 *  - The `EventPluginHub` then dispatches the events.
 *
 * Overview of React and the event system:
 *
 * +------------+    .
 * |    DOM     |    .
 * +------------+    .
 *       |           .
 *       v           .
 * +------------+    .
 * | ReactEvent |    .
 * |  Listener  |    .
 * +------------+    .                         +-----------+
 *       |           .               +--------+|SimpleEvent|
 *       |           .               |         |Plugin     |
 * +-----|------+    .               v         +-----------+
 * |     |      |    .    +--------------+                    +------------+
 * |     +-----------.--->|EventPluginHub|                    |    Event   |
 * |            |    .    |              |     +-----------+  | Propagators|
 * | ReactEvent |    .    |              |     |TapEvent   |  |------------|
 * |  Emitter   |    .    |              |<---+|Plugin     |  |other plugin|
 * |            |    .    |              |     +-----------+  |  utilities |
 * |     +-----------.--->|              |                    +------------+
 * |     |      |    .    +--------------+
 * +-----|------+    .                ^        +-----------+
 *       |           .                |        |Enter/Leave|
 *       +           .                +-------+|Plugin     |
 * +-------------+   .                         +-----------+
 * | application |   .
 * |-------------|   .
 * |             |   .
 * |             |   .
 * +-------------+   .
 *                   .
 *    React Core     .  General Purpose Event Plugin System
 */

const alreadyListeningTo = {};
let reactTopListenersCounter = 0;

/**
 * To ensure no conflicts with other potential React instances on the page
 */
const topListenersIDKey = '_reactListenersID' + ('' + Math.random()).slice(2);

function getListeningForDocument(mountAt: any) {
  // In IE8, `mountAt` is a host object and doesn't have `hasOwnProperty`
  // directly.
  if (!Object.prototype.hasOwnProperty.call(mountAt, topListenersIDKey)) { //topListenersIDKey随机数生成的常量属性，挂载到mountAt上，用于记录mountAt该节点上监听了哪些事件
    mountAt[topListenersIDKey] = reactTopListenersCounter++; //mountAt[topListenersIDKey]=1,topListenersIDKey对应绑定事件的id
    alreadyListeningTo[mountAt[topListenersIDKey]] = {};  
  }
  return alreadyListeningTo[mountAt[topListenersIDKey]]; //初次绑定事件，mountAt没有topListenersIDKey这个属性，所以alreadyListeningTo为已经绑定的所有事件为空{}，绑定事件的时候往里加
}

/**
 * We listen for bubbled touch events on the document object.
 *
 * Firefox v8.01 (and possibly others) exhibited strange behavior when
 * mounting `onmousemove` events at some node that was not the document
 * element. The symptoms were that if your mouse is not moving over something
 * contained within that mount point (for example on the background) the
 * top-level listeners for `onmousemove` won't be called. However, if you
 * register the `mousemove` on the document object, then it will of course
 * catch all `mousemove`s. This along with iOS quirks, justifies restricting
 * top-level listeners to the document object only, at least for these
 * movement types of events and possibly all events.
 *
 * @see http://www.quirksmode.org/blog/archives/2010/09/click_event_del.html
 *
 * Also, `keyup`/`keypress`/`keydown` do not bubble to the window on IE, but
 * they bubble to document.
 *
 * @param {string} registrationName Name of listener (e.g. `onClick`).
 * @param {object} mountAt Container where to mount the listener
 */
export function listenTo( //除了媒体事件绑定到元素上，其他事件都绑定到了document或document_fragment节点上
  registrationName: string,
  mountAt: Document | Element,
) {
<<<<<<< HEAD
  const isListening = getListeningForDocument(mountAt); //返回一个对象，里面是mountAt这个节点绑定的所有事件，初次绑定事件返回空{}
  const dependencies = registrationNameDependencies[registrationName]; //registrationNameDependencies:{onChange: [TOP_BLUR, TOP_CHANGE,...]}
  //dependencies:绑定registrationName事件同时，需要绑定的其他依赖事件
  for (let i = 0; i < dependencies.length; i++) { 
=======
  const isListening = getListeningForDocument(mountAt);
  const dependencies = registrationNameDependencies[registrationName];

  //注意绑定的不是registrationName和dependencies中的事件，只是属性上定义了registrationName事件，最终绑定的是其dependencies中的所有事件
  for (let i = 0; i < dependencies.length; i++) {  
>>>>>>> refs/remotes/origin/master
    const dependency = dependencies[i];
    if (!(isListening.hasOwnProperty(dependency) && isListening[dependency])) { //mountAt节点上没有绑定过dependency事件=》去绑定
      switch (dependency) {
        case TOP_SCROLL:
          trapCapturedEvent(TOP_SCROLL, mountAt);
          break;
        case TOP_FOCUS:
        case TOP_BLUR:
          trapCapturedEvent(TOP_FOCUS, mountAt);
          trapCapturedEvent(TOP_BLUR, mountAt);
          // We set the flag for a single dependency later in this function,
          // but this ensures we mark both as attached rather than just one.
          isListening[TOP_BLUR] = true;
          isListening[TOP_FOCUS] = true;
          break;
        case TOP_CANCEL:
        case TOP_CLOSE:
          if (isEventSupported(getRawEventName(dependency))) {
            trapCapturedEvent(dependency, mountAt);
          }
          break;
        case TOP_INVALID:
        case TOP_SUBMIT:
        case TOP_RESET:
          // We listen to them on the target DOM elements.
          // Some of them bubble so we don't want them to fire twice.
          break;
        default:  //注意以上事件如SCROLL、FOCUS、BLUR等监听的是捕获阶段的事件，其他默认事件即大部分事件是冒泡形式绑定的
          // By default, listen on the top level to all non-media events.
          // Media events don't bubble so adding the listener wouldn't do anything.
          const isMediaEvent = mediaEventTypes.indexOf(dependency) !== -1; //媒体相关的事件如TOP_PLAY、TOP_PAUSE、TOP_ENDED、TOP_ERROR等事件
          if (!isMediaEvent) { //不是媒体相关的事件，冒泡绑定，媒体相关事件不绑定,因为在开始setInitialProperties中媒体相关的事件先绑定之后在进行这里的事件绑定的
            trapBubbledEvent(dependency, mountAt);
          }
          break;
      }
      isListening[dependency] = true;
    }
  }
}

export function isListeningToAllDependencies(
  registrationName: string,
  mountAt: Document | Element,
) {
  const isListening = getListeningForDocument(mountAt);
  const dependencies = registrationNameDependencies[registrationName];
  for (let i = 0; i < dependencies.length; i++) {
    const dependency = dependencies[i];
    if (!(isListening.hasOwnProperty(dependency) && isListening[dependency])) {
      return false;
    }
  }
  return true;
}

export {setEnabled, isEnabled, trapBubbledEvent, trapCapturedEvent};
