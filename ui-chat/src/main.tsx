import React from "react";
import ReactDOM from "react-dom/client";
import { FluentProvider, webDarkTheme } from "@fluentui/react-components";
import { App } from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <FluentProvider theme={webDarkTheme}>
    <App />
  </FluentProvider>
);
