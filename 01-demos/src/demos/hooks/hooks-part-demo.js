/**
 * 必须要react和react-dom 16.8以上
 */

import React, {
  memo,
  createContext,
  forwardRef,
  useState,
  useEffect,
  useCallback,
  useContext,
  useRef,
  useImperativeHandle,
} from "react";

const TestContext = createContext("default");

const Comp = memo((props) => {
  useEffect(() => {
    console.log("comp updated");
  });

  const updateValue = () => {
    props.onChick(props.name + "1");
  };

  return <button onClick={updateValue}>button {props.name}</button>;
});

const ContextComp = forwardRef((props, ref) => { 
  const [name] = useState("123");
  const context = useContext(TestContext);

  useEffect(() => {
    console.log("context comp updated");
  });

  useImperativeHandle(ref, () => ({ //向ref上挂载了一些方法，ref是不能使用在functionComponent上的，因为没有current实例，所以不能通过this等添加东西，需通过这个方法实现
    method() {
      console.log("method invoked");
    },
  }));

  return (
    <p>
      {context} {name}
    </p>
  );
});

export default function App() {
  const [name, setName] = useState("jokcy");
  const [compName, setCompName] = useState("compName");

  const ref = useRef();

  useEffect(() => {
    console.log("component update");

    ref.current.method();

    // api.sub

    return () => {
      console.log("unbind");
    };
  }, [name]); // 去掉这个数组就会每次都调用

  const compCallback = useCallback(
    (value) => {
      setCompName(value);
    },
    [compName]
  ); // 演示没有`[compName]`每次Comp都会调用effect：该函数组件name的state发生变化整个组件就会更新，若是没有第二个参数，那么每次返回的函数都是一个新的函数=》是用他的Comp组件 props就会不断发生变化就需要不断更新
  //加了第二个参数，就会根据这个值是否变化来返回旧的函数还是新的函数

  return (
    <>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Comp name={compName} onClick={compCallback} />
      <TestContext.Provider value={name}>
        <ContextComp ref={ref} />
      </TestContext.Provider>
    </>
  );
}
