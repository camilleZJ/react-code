/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as EventPluginHub from 'events/EventPluginHub'; //无相对路径的events是来自events packages包中的内容
import * as EventPluginUtils from 'events/EventPluginUtils';

import {
  getFiberCurrentPropsFromNode,
  getInstanceFromNode,
  getNodeFromInstance,
} from './ReactDOMComponentTree';
import BeforeInputEventPlugin from '../events/BeforeInputEventPlugin';
import ChangeEventPlugin from '../events/ChangeEventPlugin';
import DOMEventPluginOrder from '../events/DOMEventPluginOrder';
import EnterLeaveEventPlugin from '../events/EnterLeaveEventPlugin';
import SelectEventPlugin from '../events/SelectEventPlugin';
import SimpleEventPlugin from '../events/SimpleEventPlugin';

/**
 * Inject modules for resolving DOM hierarchy and plugin ordering.
 */
EventPluginHub.injection.injectEventPluginOrder(DOMEventPluginOrder); //DOMEventPluginOrder为数组，其中数组内元素为各个事件插件名字
EventPluginUtils.setComponentTree(
  getFiberCurrentPropsFromNode,
  getInstanceFromNode,
  getNodeFromInstance,
);

/**
 * Some important event plugins included by default (without having to require
 * them).
 */
EventPluginHub.injection.injectEventPluginsByName({ //根据插件的名字拿到相应插件，与DOMEventPluginOrder中的插件一至，只是少了ResponderEventPlugin
  SimpleEventPlugin: SimpleEventPlugin,
  EnterLeaveEventPlugin: EnterLeaveEventPlugin,
  ChangeEventPlugin: ChangeEventPlugin,
  SelectEventPlugin: SelectEventPlugin,
  BeforeInputEventPlugin: BeforeInputEventPlugin,
});
