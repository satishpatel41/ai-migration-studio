import { bindable } from 'aurelia-framework';

export class TodoItem {
  @bindable todo;
  @bindable remove;
  editing = false;

  toggleEdit() {
    this.editing = !this.editing;
  }

  todoChanged(newValue) {
    console.log('todo changed', newValue);
  }

  detached() {
    console.log('bye');
  }
}
