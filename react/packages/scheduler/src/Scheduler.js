/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* eslint-disable no-var */

// TODO: Use symbols?
var ImmediatePriority = 1;
var UserBlockingPriority = 2;
var NormalPriority = 3;
var IdlePriority = 4;

// Max 31 bit integer. The max integer size in V8 for 32-bit systems.
// Math.pow(2, 30) - 1
// 0b111111111111111111111111111111
var maxSigned31BitInt = 1073741823;

// Times out immediately
var IMMEDIATE_PRIORITY_TIMEOUT = -1;
// Eventually times out
var USER_BLOCKING_PRIORITY = 250;
var NORMAL_PRIORITY_TIMEOUT = 5000;
// Never times out
var IDLE_PRIORITY = maxSigned31BitInt;

// Callbacks are stored as a circular, doubly linked list.
var firstCallbackNode = null;

var currentPriorityLevel = NormalPriority;
var currentEventStartTime = -1;
var currentExpirationTime = -1;

// This is set when a callback is being executed, to prevent re-entrancy.
var isExecutingCallback = false;

var isHostCallbackScheduled = false;

var hasNativePerformanceNow =
  typeof performance === 'object' && typeof performance.now === 'function';

var timeRemaining;
if (hasNativePerformanceNow) {
  timeRemaining = function() {
    if (
      firstCallbackNode !== null &&
      firstCallbackNode.expirationTime < currentExpirationTime
    ) {
      // A higher priority callback was scheduled. Yield so we can switch to
      // working on that.
      return 0;
    }
    // We assume that if we have a performance timer that the rAF callback
    // gets a performance timer value. Not sure if this is always true.
    var remaining = getFrameDeadline() - performance.now(); //getFrameDeadline()获取上面的frameDeadline
    return remaining > 0 ? remaining : 0;   //这一帧的渲染时间是否已经超过
  };
} else {
  timeRemaining = function() {
    // Fallback to Date.now()
    if (
      firstCallbackNode !== null &&
      firstCallbackNode.expirationTime < currentExpirationTime
    ) {
      return 0;
    }
    var remaining = getFrameDeadline() - Date.now();
    return remaining > 0 ? remaining : 0;
  };
}

var deadlineObject = {
  timeRemaining,
  didTimeout: false,
};

function ensureHostCallbackIsScheduled() {
  if (isExecutingCallback) {  //已经有callbackNode在调用了，开启了调度会进行循环处理，所以不需要再开启了
    // Don't schedule work yet; wait until the next time we yield.
    return;
  }
  // Schedule the host callback using the earliest expiration in the list.
  var expirationTime = firstCallbackNode.expirationTime;
  if (!isHostCallbackScheduled) { //host callback没有进行调度
    isHostCallbackScheduled = true;
  } else {
    // Cancel the existing host callback.
    cancelHostCallback();  //取消之前的
  }
  requestHostCallback(flushWork, expirationTime);
}

function flushFirstCallback() {
  var flushedNode = firstCallbackNode;

  // Remove the node from the list before calling the callback. That way the
  // list is in a consistent state even if the callback throws.
  var next = firstCallbackNode.next;
  if (firstCallbackNode === next) {  //链表中就一个node就是firstCallbackNode
    // This is the last callback in the list.
    firstCallbackNode = null; //就一个node，也就是现在正在处理的是flushedNode = firstCallbackNode（firstCallbackNode已经被处理了，需要使其指向下一个），那么下一个处理的就没有了
    next = null;
  } else {
    //firstCallbackNode已经在处理中了并赋值给了flushedNode，那么现在链表中就需要把处理中的firstCallbackNode删掉也就是指针指定firstCallbackNode的next为新的firstCallbackNode
    var lastCallbackNode = firstCallbackNode.previous; //因为是环状的链表，所以firstCallbackNode.previous指向的是最后一个节点
    firstCallbackNode = lastCallbackNode.next = next;  //通过指针指定正在处理的节点的next为新的firstCallbackNode，并且从这个开始指向最后一个形成新的环形链表
    next.previous = lastCallbackNode;  //新的firstCallbackNode指向最后一个形成新的环状链表
  }

  flushedNode.next = flushedNode.previous = null; //清空链表中的指向，防止后续指向的对象内存清空不了，导致内存溢出

  // Now it's safe to call the callback.
  var callback = flushedNode.callback;
  var expirationTime = flushedNode.expirationTime;
  var priorityLevel = flushedNode.priorityLevel;
  var previousPriorityLevel = currentPriorityLevel;
  var previousExpirationTime = currentExpirationTime;
  currentPriorityLevel = priorityLevel;
  currentExpirationTime = expirationTime;
  var continuationCallback;
  try {
    continuationCallback = callback(deadlineObject); //执行了callback
  } finally {
    currentPriorityLevel = previousPriorityLevel;
    currentExpirationTime = previousExpirationTime;
  }

  //以下目前不会进行到，callback：performAsyncWork没有任何返回，所以continuationCallback没有值
  // A callback may return a continuation. The continuation should be scheduled
  // with the same priority and expiration as the just-finished callback.
  if (typeof continuationCallback === 'function') {  //回调的回调还像之前一样处理，按照优先级将node添加到环形链表中
    var continuationNode: CallbackNode = {
      callback: continuationCallback,
      priorityLevel,
      expirationTime,
      next: null,
      previous: null,
    };

    // Insert the new callback into the list, sorted by its expiration. This is
    // almost the same as the code in `scheduleCallback`, except the callback
    // is inserted into the list *before* callbacks of equal expiration instead
    // of after.
    if (firstCallbackNode === null) {
      // This is the first callback in the list.
      firstCallbackNode = continuationNode.next = continuationNode.previous = continuationNode;
    } else {
      var nextAfterContinuation = null;
      var node = firstCallbackNode;
      do {
        if (node.expirationTime >= expirationTime) {
          // This callback expires at or after the continuation. We will insert
          // the continuation *before* this callback.
          nextAfterContinuation = node;
          break;
        }
        node = node.next;
      } while (node !== firstCallbackNode);

      if (nextAfterContinuation === null) {
        // No equal or lower priority callback was found, which means the new
        // callback is the lowest priority callback in the list.
        nextAfterContinuation = firstCallbackNode;
      } else if (nextAfterContinuation === firstCallbackNode) {
        // The new callback is the highest priority callback in the list.
        firstCallbackNode = continuationNode;
        ensureHostCallbackIsScheduled();
      }

      var previous = nextAfterContinuation.previous;
      previous.next = nextAfterContinuation.previous = continuationNode;
      continuationNode.next = nextAfterContinuation;
      continuationNode.previous = previous;
    }
  }
}

function flushImmediateWork() {
  if (
    // Confirm we've exited the outer most event handler
    currentEventStartTime === -1 &&
    firstCallbackNode !== null &&
    firstCallbackNode.priorityLevel === ImmediatePriority  //默认值priorityLevel=normalPriority,整个过程没有修改过
  ) {
    isExecutingCallback = true;
    deadlineObject.didTimeout = true;
    try {
      do {
        flushFirstCallback();
      } while (
        // Keep flushing until there are no more immediate callbacks
        firstCallbackNode !== null &&
        firstCallbackNode.priorityLevel === ImmediatePriority
      );
    } finally {
      isExecutingCallback = false;
      if (firstCallbackNode !== null) {
        // There's still work remaining. Request another callback.
        ensureHostCallbackIsScheduled();
      } else {
        isHostCallbackScheduled = false;
      }
    }
  }
}

function flushWork(didTimeout) { //开始真正执行callback
  isExecutingCallback = true; //ensureHostCallbackIsScheduled,中会判断此值为true 直接return说明已经在处理里(循环处理链表，所以开始了链表中的都会执行到，所以不需要处理了-return)
  deadlineObject.didTimeout = didTimeout; //是否超时需要强制执行
  try {
    if (didTimeout) {
      // Flush all the expired callbacks without yielding.
      while (firstCallbackNode !== null) {
        // Read the current time. Flush all the callbacks that expire at or
        // earlier than that time. Then read the current time again and repeat.
        // This optimizes for as few performance.now calls as possible.
        var currentTime = getCurrentTime();
        if (firstCallbackNode.expirationTime <= currentTime) { //已经过期了
          do {
            flushFirstCallback(); 
          } while (
            firstCallbackNode !== null &&
            firstCallbackNode.expirationTime <= currentTime 
          ); //try中flushFirstCallback执行后，firstCallbackNode变为了下一个，所以此处还需判断
          continue;
        }
        break;
      }
    } else {
      // Keep flushing callbacks until we run out of time in the frame.
      if (firstCallbackNode !== null) {
        do {
          flushFirstCallback();
        } while (
          firstCallbackNode !== null &&
          getFrameDeadline() - getCurrentTime() > 0 //还有剩余时间，这一帧时间还没执行完有多余时间情况下才执行上面的flushFirstCallback
        );
      }
    }
  } finally {
    isExecutingCallback = false; //finally是callback执行完了
    if (firstCallbackNode !== null) {
      // There's still work remaining. Request another callback.
      ensureHostCallbackIsScheduled();  //firstCallbackNode已经指向下一个，开始执行队列中的下一个
    } else {
      isHostCallbackScheduled = false; //ensureHostCallbackIsScheduled中设置为true
    }
    // Before exiting, flush all the immediate work that was scheduled.
    flushImmediateWork(); //其中if条件满足才执行逻辑处理，目前没用到if不满足，为了以后写在此处的
  }
}

function unstable_runWithPriority(priorityLevel, eventHandler) {
  switch (priorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
    case IdlePriority:
      break;
    default:
      priorityLevel = NormalPriority;
  }

  var previousPriorityLevel = currentPriorityLevel;
  var previousEventStartTime = currentEventStartTime;
  currentPriorityLevel = priorityLevel;
  currentEventStartTime = getCurrentTime();

  try {
    return eventHandler();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
    currentEventStartTime = previousEventStartTime;

    // Before exiting, flush all the immediate work that was scheduled.
    flushImmediateWork();
  }
}

function unstable_wrapCallback(callback) {
  var parentPriorityLevel = currentPriorityLevel;
  return function() {
    // This is a fork of runWithPriority, inlined for performance.
    var previousPriorityLevel = currentPriorityLevel;
    var previousEventStartTime = currentEventStartTime;
    currentPriorityLevel = parentPriorityLevel;
    currentEventStartTime = getCurrentTime();

    try {
      return callback.apply(this, arguments);
    } finally {
      currentPriorityLevel = previousPriorityLevel;
      currentEventStartTime = previousEventStartTime;
      flushImmediateWork();
    }
  };
}

function unstable_scheduleCallback(callback, deprecated_options) { //deprecated_options即将被废弃的参数
  var startTime =
    currentEventStartTime !== -1 ? currentEventStartTime : getCurrentTime(); //getCurrentTime()：localDate.now()，获取到的就是getCurrentTime

  var expirationTime;
  if (
    typeof deprecated_options === 'object' &&
    deprecated_options !== null &&
    typeof deprecated_options.timeout === 'number'
  ) {
    // FIXME: Remove this branch once we lift expiration times out of React.
    expirationTime = startTime + deprecated_options.timeout;  //进入此判断，注意上面的注释提示：把expiration times从react中单拿出的时候这个if判断就去掉，都是走下面的
  } else {
    switch (currentPriorityLevel) {
      case ImmediatePriority:
        expirationTime = startTime + IMMEDIATE_PRIORITY_TIMEOUT;
        break;
      case UserBlockingPriority:
        expirationTime = startTime + USER_BLOCKING_PRIORITY;
        break;
      case IdlePriority:
        expirationTime = startTime + IDLE_PRIORITY;
        break;
      case NormalPriority:
      default:
        expirationTime = startTime + NORMAL_PRIORITY_TIMEOUT;
    }
  }

  var newNode = {
    callback,
    priorityLevel: currentPriorityLevel,
    expirationTime,
    next: null,
    previous: null,
  };

  // Insert the new callback into the list, ordered first by expiration, then
  // by insertion. So the new callback is inserted any other callback with
  // equal expiration.
  if (firstCallbackNode === null) {  //单向列表头部firstCallbackNode
    // This is the first callback in the list.
    firstCallbackNode = newNode.next = newNode.previous = newNode;
    ensureHostCallbackIsScheduled();
  } else {  //链表不为空
    var next = null;
    var node = firstCallbackNode;
    do { //按照优先级排序，把优先级高的排在最前面
      if (node.expirationTime > expirationTime) { //找到第一个优先级比当前expirationTime小的
        // The new callback expires before this one.
        next = node;
        break;
      }
      node = node.next;
    } while (node !== firstCallbackNode);

    if (next === null) {  //没找到=》链表中的所有优先级都比expirationTime高，expirationTime优先级最低
      // No callback with a later expiration was found, which means the new
      // callback has the latest expiration in the list.
      next = firstCallbackNode;
    } else if (next === firstCallbackNode) { //expirationTime优先级高于当前的firstCallbackNode的优先级，即expirationTime最高的=》需要放到链表的最前面
      // The new callback has the earliest expiration in the entire list.
      firstCallbackNode = newNode;
      ensureHostCallbackIsScheduled();
    }

    //newNode优先级最低-》插入到链表最后：next = firstCallbackNode;  previous = next.previous-原链表的最后一项 previous.next=newNode将newNode插入到链表最后，重新修改next.previous指向最新的最后一项newNode
    //newNode优先级最高-》插入到链表最前：next === firstCallbackNode(链表最开始的第一项)；previous = next.previous-链表的最后一项，previous.next构成循环链表指向最新的第一项newNode，next.previous之前的第一项变成了第二项，他的previous就是指向了前一个也就是新的第一项newNode
    //newNode插入到链表中间部分及next的前面，next.previous：未插入newNode时next的前一项，newNode就是插入到next.previous和next之间
    var previous = next.previous;
    previous.next = next.previous = newNode; 
    newNode.next = next;
    newNode.previous = previous; 
    //newNode插入到链表最后：newNode.next还是链表的第一项，newNode.previous指向链表之前的最后一项，也就是新链表倒数第二项即newNode的前一项
    //newNode插入到链表最前：newNode.next指向最开始的第一项，newNode.previous指向链表中的最后一项
  }

  return newNode;
}

function unstable_cancelCallback(callbackNode) {
  var next = callbackNode.next;
  if (next === null) {
    // Already cancelled.
    return;
  }

  if (next === callbackNode) {
    // This is the only scheduled callback. Clear the list.
    firstCallbackNode = null;
  } else {
    // Remove the callback from its position in the list.
    if (callbackNode === firstCallbackNode) {
      firstCallbackNode = next;
    }
    var previous = callbackNode.previous;
    previous.next = next;
    next.previous = previous;
  }

  callbackNode.next = callbackNode.previous = null;
}

function unstable_getCurrentPriorityLevel() {
  return currentPriorityLevel;
}

// The remaining code is essentially a polyfill for requestIdleCallback. It
// works by scheduling a requestAnimationFrame, storing the time for the start
// of the frame, then scheduling a postMessage which gets scheduled after paint.
// Within the postMessage handler do as much work as possible until time + frame
// rate. By separating the idle call into a separate event tick we ensure that
// layout, paint and other browser work is counted against the available time.
// The frame rate is dynamically adjusted.

// We capture a local reference to any global, in case it gets polyfilled after
// this module is initially evaluated. We want to be using a
// consistent implementation.
var localDate = Date;

// This initialization code may run even on server environments if a component
// just imports ReactDOM (e.g. for findDOMNode). Some environments might not
// have setTimeout or clearTimeout. However, we always expect them to be defined
// on the client. https://github.com/facebook/react/pull/13088
var localSetTimeout = typeof setTimeout === 'function' ? setTimeout : undefined;
var localClearTimeout =
  typeof clearTimeout === 'function' ? clearTimeout : undefined;

// We don't expect either of these to necessarily be defined, but we will error
// later if they are missing on the client.
var localRequestAnimationFrame =
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : undefined;
var localCancelAnimationFrame =
  typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : undefined;

var getCurrentTime;

// requestAnimationFrame does not run when the tab is in the background. If
// we're backgrounded we prefer for that work to happen so that the page
// continues to load in the background. So we also schedule a 'setTimeout' as
// a fallback.
// TODO: Need a better heuristic for backgrounded work.
var ANIMATION_FRAME_TIMEOUT = 100;
var rAFID;
var rAFTimeoutID;
var requestAnimationFrameWithTimeout = function(callback) {
  // schedule rAF and also a setTimeout
  rAFID = localRequestAnimationFrame(function(timestamp) { //相当于window.requestAnimationFrame API,执行一个动画，该回调函数会在浏览器下一次重绘之前执行,继续更新下一帧动画，那么回调函数自身必须再次调用,返回请求 ID ，是回调列表中唯一的标识。可以传这个值给 window.cancelAnimationFrame() 以取消回调函数
    // cancel the setTimeout
    localClearTimeout(rAFTimeoutID); //window.clearTimeout()
    callback(timestamp);
  });
  rAFTimeoutID = localSetTimeout(function() {  //window.setTimeout
    // cancel the requestAnimationFrame
    localCancelAnimationFrame(rAFID); //超过100ms，就取消，防止requestAnimationFrame超时
    callback(getCurrentTime());
  }, ANIMATION_FRAME_TIMEOUT);
};

if (hasNativePerformanceNow) {
  var Performance = performance;
  getCurrentTime = function() {
    return Performance.now();
  };
} else {
  getCurrentTime = function() {
    return localDate.now();  //浏览器获取的是这个时间
  };
}

var requestHostCallback;
var cancelHostCallback;
var getFrameDeadline;

if (typeof window !== 'undefined' && window._schedMock) { //非浏览器环境
  // Dynamic injection, only for testing purposes.
  var impl = window._schedMock;
  requestHostCallback = impl[0];
  cancelHostCallback = impl[1];
  getFrameDeadline = impl[2];
} else if (
  // If Scheduler runs in a non-DOM environment, it falls back to a naive
  // implementation using setTimeout.
  typeof window === 'undefined' ||
  // "addEventListener" might not be available on the window object
  // if this is a mocked "window" object. So we need to validate that too.
  typeof window.addEventListener !== 'function'
) {
  var _callback = null;
  var _currentTime = -1;
  var _flushCallback = function(didTimeout, ms) {
    if (_callback !== null) {
      var cb = _callback;
      _callback = null;
      try {
        _currentTime = ms;
        cb(didTimeout);
      } finally {
        _currentTime = -1;
      }
    }
  };
  requestHostCallback = function(cb, ms) {
    if (_currentTime !== -1) {
      // Protect against re-entrancy.
      setTimeout(requestHostCallback, 0, cb, ms);
    } else {
      _callback = cb;
      setTimeout(_flushCallback, ms, true, ms);
      setTimeout(_flushCallback, maxSigned31BitInt, false, maxSigned31BitInt);
    }
  };
  cancelHostCallback = function() {
    _callback = null;
  };
  getFrameDeadline = function() {
    return Infinity;
  };
  getCurrentTime = function() {
    return _currentTime === -1 ? 0 : _currentTime;
  };
} else {  //浏览器环境
  if (typeof console !== 'undefined') { //API兼容性检测，不支持加载polyfill
    // TODO: Remove fb.me link
    if (typeof localRequestAnimationFrame !== 'function') {
      console.error(
        "This browser doesn't support requestAnimationFrame. " +
          'Make sure that you load a ' +
          'polyfill in older browsers. https://fb.me/react-polyfills',
      );
    }
    if (typeof localCancelAnimationFrame !== 'function') {
      console.error(
        "This browser doesn't support cancelAnimationFrame. " +
          'Make sure that you load a ' +
          'polyfill in older browsers. https://fb.me/react-polyfills',
      );
    }
  }

  var scheduledHostCallback = null;
  var isMessageEventScheduled = false;
  var timeoutTime = -1;

  var isAnimationFrameScheduled = false;

  var isFlushingHostCallback = false;

  var frameDeadline = 0;
  // We start out assuming that we run at 30fps but then the heuristic tracking
  // will adjust this value to a faster fps if we get more frequent animation
  // frames.
  var previousFrameTime = 33;
  var activeFrameTime = 33;  //保证浏览器每秒30帧，那么平均33ms一帧

  getFrameDeadline = function() {
    return frameDeadline;
  };

  // We use the postMessage trick to defer idle work until after the repaint.
  var messageKey =
    '__reactIdleCallback$' +
    Math.random()
      .toString(36)
      .slice(2);
  var idleTick = function(event) {  //判断是否还有帧时间
    if (event.source !== window || event.data !== messageKey) { //确定是发给自己
      return;
    }

    isMessageEventScheduled = false;

    var prevScheduledCallback = scheduledHostCallback;
    var prevTimeoutTime = timeoutTime;
    scheduledHostCallback = null;
    timeoutTime = -1;

    var currentTime = getCurrentTime();

    var didTimeout = false;
    if (frameDeadline - currentTime <= 0) { //frameDeadline - currentTime <= 0说明浏览器更新动画或用户反馈的时间已经用完了33ms，就是没有留给react时间去更新动画
      // There's no time left in this idle period. Check if the callback has
      // a timeout and whether it's been exceeded.
      if (prevTimeoutTime !== -1 && prevTimeoutTime <= currentTime) { //判断timeoutTime小于等于currentTime，就是已过期=>强制进行更新
        // Exceeded the timeout. Invoke the callback even though there's no
        // time left.
        didTimeout = true;
      } else {
        // No timeout.
        if (!isAnimationFrameScheduled) {
          // Schedule another animation callback so we retry later.
          isAnimationFrameScheduled = true;
          requestAnimationFrameWithTimeout(animationTick);
        }
        // Exit without invoking the callback.
        scheduledHostCallback = prevScheduledCallback; //占用下一帧的时间
        timeoutTime = prevTimeoutTime;
        return;
      }
    }

    if (prevScheduledCallback !== null) {
      isFlushingHostCallback = true;  //正在调用这个callback
      try {
        prevScheduledCallback(didTimeout); //调用callback，看是否是强制执行
      } finally {
        isFlushingHostCallback = false; //callback执行完了
      }
    }
  };
  // Assumes that we have addEventListener in this environment. Might need
  // something better for old IE.
  window.addEventListener('message', idleTick, false);  //postMessage后接收方接收，此时浏览器的刷新已经完成，也就是一帧内浏览器时间用掉了，剩下的是react的执行时间

  var animationTick = function(rafTime) {
    if (scheduledHostCallback !== null) {
      // Eagerly schedule the next animation callback at the beginning of the
      // frame. If the scheduler queue is not empty at the end of the frame, it
      // will continue flushing inside that callback. If the queue *is* empty,
      // then it will exit immediately. Posting the callback at the start of the
      // frame ensures it's fired within the earliest possible frame. If we
      // waited until the end of the frame to post the callback, we risk the
      // browser skipping a frame and not firing the callback until the frame
      // after that.
      requestAnimationFrameWithTimeout(animationTick); //firstCallback是一个队列，里面有很多的callback，而animationTick只一个一个执行，下一帧也需要执行，此处是为了防止callback执行完在执行下一帧的此函数
    } else {
      // No pending work. Exit.
      isAnimationFrameScheduled = false;  //按照上面的流程是为true的
      return;
    }

    //这个方法到下一阵执行的时间  rafTime下一帧动画刚开始渲染，一定还没达到一帧的时间：33ms
    var nextFrameTime = rafTime - frameDeadline + activeFrameTime; 
    if (
      nextFrameTime < activeFrameTime &&
      previousFrameTime < activeFrameTime
    ) {  //rafTime - frameDeadline是小于或等于0的,会进入nextFrameTime < activeFrameTime,
      if (nextFrameTime < 8) {  //8ms-120帧，浏览器不支持小于平均8ms一帧的，即不支持每秒大于120帧，最高是每秒120帧
        // Defensive coding. We don't support higher frame rates than 120hz.
        // If the calculated frame time gets lower than 8, it is probably a bug.
        nextFrameTime = 8;
      }
      // If one frame goes long, then the next one can be short to catch up.
      // If two frames are short in a row, then that's an indication that we
      // actually have a higher frame rate than what we're currently optimizing.
      // We adjust our heuristic dynamically accordingly. For example, if we're
      // running on 120hz display or 90hz VR display.
      // Take the max of the two in case one of them was an anomaly due to
      // missed frame deadlines.
      activeFrameTime =
        nextFrameTime < previousFrameTime ? previousFrameTime : nextFrameTime; //以上两个条件(连续两次-两帧动画)都小于activeFrameTime：33ms，说明浏览器是高刷新率的浏览器，即每秒大于30帧，所以平均一帧小于33ms，就修改activeFrameTime,基于上面不改小的话，会导致浏览器没有足够时间执行动画-考虑不同平台刷新率的问题
    } else {
      previousFrameTime = nextFrameTime; //第一次frameDeadline=0，进入此处
    }
    frameDeadline = rafTime + activeFrameTime; //问题说明：此处activeFrameTime-33ms是一帧动画的时间，那么依据讲解一帧动画时间包括react+浏览器，此处使用33是不是把浏览器时间都占了，没给浏览器留下处理时间？
    //解释上面的问题：react是把这些帧的处理放到队列中的，requestAnimationFrameWithTimeout把回调加入，这个方法执行完立马进入浏览器动画刷新的流程
    //是以上动画和浏览器都执行完成后才执行window.postMessage，即window.postMessage是等浏览器刷新完成后才接收到的，此时浏览器刷新的时间已经过了
    //所以rafTime + activeFrameTime是已经包含了浏览器刷新动画的时间，剩下来的是react执行动画的时间，这就是react模拟window.requestIdleCallback() API
    if (!isMessageEventScheduled) {
      isMessageEventScheduled = true;
      window.postMessage(messageKey, '*');  //任务队列，等到浏览器用户输入、动画等执行完成后才能postMessage，也就是等到浏览器刷新完成后接收方才能收到，所以以上的frameDeadline已经包含了浏览器用掉的一部分时间
    }
  };

  requestHostCallback = function(callback, absoluteTimeout) {
    scheduledHostCallback = callback;
    timeoutTime = absoluteTimeout;
    if (isFlushingHostCallback || absoluteTimeout < 0) { //已经超时了不需要等待立马执行
      // Don't wait for the next frame. Continue working ASAP, in a new event.
      window.postMessage(messageKey, '*');
    } else if (!isAnimationFrameScheduled) {  //进入正常调度流程
      // If rAF didn't already schedule one, we need to schedule a frame.
      // TODO: If this rAF doesn't materialize because the browser throttles, we
      // might want to still have setTimeout trigger rIC as a backup to ensure
      // that we keep performing work.
      isAnimationFrameScheduled = true;
      requestAnimationFrameWithTimeout(animationTick);
    }
  };

  cancelHostCallback = function() {
    scheduledHostCallback = null;
    isMessageEventScheduled = false;
    timeoutTime = -1;
  };
}

export {
  ImmediatePriority as unstable_ImmediatePriority,
  UserBlockingPriority as unstable_UserBlockingPriority,
  NormalPriority as unstable_NormalPriority,
  IdlePriority as unstable_IdlePriority,
  unstable_runWithPriority,
  unstable_scheduleCallback,
  unstable_cancelCallback,
  unstable_wrapCallback,
  unstable_getCurrentPriorityLevel,
  getCurrentTime as unstable_now,
};
