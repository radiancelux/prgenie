// DEMO FILE: intentionally has a lint error to demonstrate shepherd CI gate
const unusedVariable = "this will trigger unused var lint error";

export function demoFunction() {
  console.log("Hello");
}
