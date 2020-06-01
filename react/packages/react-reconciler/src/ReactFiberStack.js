/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber} from './ReactFiber';

import warningWithoutStack from 'shared/warningWithoutStack';

export type StackCursor<T> = {
  current: T,
};

const valueStack: Array<any> = []; //很重要的变量

let fiberStack: Array<Fiber | null>; //如下只是用于开发环境下，可忽略

if (__DEV__) {
  fiberStack = [];
}

let index = -1; //valueStack中目前存数据存贮到的位置

function createCursor<T>(defaultValue: T): StackCursor<T> {
  return {
    current: defaultValue,
  };
}

function isEmpty(): boolean {
  return index === -1;
}

function pop<T>(cursor: StackCursor<T>, fiber: Fiber): void {
  if (index < 0) { //栈是空的
    if (__DEV__) {
      warningWithoutStack(false, 'Unexpected pop.');
    }
    return;
  }

  if (__DEV__) {
    if (fiber !== fiberStack[index]) {
      warningWithoutStack(false, 'Unexpected Fiber popped.');
    }
  }

<<<<<<< HEAD
=======
  //问题：[a, b, c] =》 c1, c2, c3，pop值得时候：想要拿c1的pop出来的确是c3的
  //这个问题react中没解决因为react显示入栈再出栈，在代码中保持出栈对应的顺序，而不是在此文件中控制
>>>>>>> df9d105336bca74b3a7c9aefa52823435a962e96
  cursor.current = valueStack[index];  //push的时候是把老的值入栈，新值挂载到cursor=》pop反过来就是把老的值出栈挂回当前的cursor上

  valueStack[index] = null;

  if (__DEV__) {
    fiberStack[index] = null;
  }

  index--;
}

function push<T>(cursor: StackCursor<T>, value: T, fiber: Fiber): void {
  index++;

  valueStack[index] = cursor.current; //注意：push是把老的值入栈，新值挂载道cursor上

  if (__DEV__) {
    fiberStack[index] = fiber;
  }

  cursor.current = value; //注意push时是把cursor之前的值入栈，当前的值不入栈只是存在如cursor中
}

function checkThatStackIsEmpty() {
  if (__DEV__) {
    if (index !== -1) {
      warningWithoutStack(
        false,
        'Expected an empty stack. Something was not reset properly.',
      );
    }
  }
}

function resetStackAfterFatalErrorInDev() {
  if (__DEV__) {
    index = -1;
    valueStack.length = 0;
    fiberStack.length = 0;
  }
}

export {
  createCursor,
  isEmpty,
  pop,
  push,
  // DEV only:
  checkThatStackIsEmpty,
  resetStackAfterFatalErrorInDev,
};
