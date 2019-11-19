/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {LazyComponent, Thenable} from 'shared/ReactLazyComponent';

import {REACT_LAZY_TYPE} from 'shared/ReactSymbols';

export function lazy<T, R>(ctor: () => Thenable<T, R>): LazyComponent<T> {
  return {
    $$typeof: REACT_LAZY_TYPE,
    _ctor: ctor,  //传进来的方法，如()=>import()
    // React uses these fields to store the result.
    _status: -1,  //promise加载数据的不同状态会变
    _result: null,  //记录Thenable之后（如import()）返回的结果 
  };
}
