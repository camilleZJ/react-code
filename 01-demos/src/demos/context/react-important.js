//state：
class Parent extends React.Component {
  state = {
    childContext: "123",
    newContext: "456",
  };
 // 或;
  constructor(props) {
    super(props);
    this.state = {
      childContext: "123",
      newContext: "456",
    };
  }
}

//context
const MyContext = React.createContext('light'); 
//MyContext.displayName = 'MyDisplayName';
//<MyContext.Provider> // "MyDisplayName.Provider" 在 DevTools 中
//<MyContext.Consumer> // "MyDisplayName.Consumer" 在 DevTools 中
const {Provider, Consumer} = React.createContext('default');
<Provider value=".." ></Provider> <Consumer>{value=>"..reactNode...."}</Consumer>
// 或者Consumer使用如下：
// 组件.contextType = Consumer，在组建内部使用this.context
class MyClass extends React.Component {
    static contextType = MyContext;
    render() {
      let value = this.context;
      /* 基于这个值进行渲染工作 */
    }
  }
// 旧的context API：
//     提供者：getChildContext(){return {value： ...};} //如提供value
//         Parent.childContextTypes = {
//             vale: PropTypes.String
//         }
//     使用者child：child.contextTypes = { //注意新的context API组件的属性是contextType 没有s
//         value: PropTypes.String //如使用提供者的value
//     }
//     内部render显示时直接调用: {this.context.val

//注意：
// 组件会从组件树中离自身最近的那个匹配的 Provider 中读取到当前的 context 值。
// 只有当组件所处的树中没有匹配到 Provider 时，其 defaultValue 参数才会生效。即使Provider 的 value 为Provider 的 value ， defaultValue 也不会生效。
// 当 Provider 的 value 值发生变化时，它内部的所有消费组件都会重新渲染。Provider 及其内部 consumer 组件都不受制于 shouldComponentUpdate 函数，因此当 consumer 组件在其祖先组件退出更新的情况下也能更新。

//children
class Text extends React.Component{
    render() {
        return <div>{this.props.children}</div>
    }
}

const Button = () => {
    return (
        <Text>
            <p>hellow</p>
        </Text>
    );
}
