// @ts-expect-error no types
import styles from "./App.module.css";
import { Counter } from "./Counter.js";

const App = ({ name = "Anonymous" }) => {
  return (
    <div style={{ border: "3px red dashed", margin: "1em", padding: "1em" }}>
      <h1 className={styles.title}>Hello {name}!!</h1>
      <h3>This is a server component.</h3>
      <Counter />
    </div>
  );
};

export default App;
