import { inject } from 'aurelia-framework';
import { TodoService } from './todo-service';

@inject(TodoService)
export class App {
  heading = 'Todos';
  todos = [];
  newTodoText = '';
  filter = 'all';

  constructor(todoService) {
    this.todoService = todoService;
  }

  async attached() {
    this.todos = await this.todoService.load();
  }

  addTodo() {
    if (this.newTodoText) {
      this.todos.push({ text: this.newTodoText, done: false, id: Date.now() });
      this.newTodoText = '';
    }
  }

  removeTodo(todo) {
    const index = this.todos.indexOf(todo);
    this.todos.splice(index, 1);
  }

  get remaining() {
    return this.todos.filter((t) => !t.done).length;
  }
}
