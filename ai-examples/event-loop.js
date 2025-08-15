// this file explain event lopp class object under the hood

const callStacks = [];
const callbackQueues = [];

class EventLoop {
	constructor() {
		this.running = false;
		this.microTasks = [];
		this.macroTasks = [];
	}

	setTask(task) {
		this.macroTasks.push(task);
	}

	setMicroTask(task) {
		this.microTasks.push(task);
	}

	run() {
		if (this.running) return;
		this.running = true;

		const loop = () => {
			while (this.microTasks.length > 0) {
				const micro = this.microTasks.shift();
				micro();
			}
			while (this.macroTasks.length > 0) {
				const task = this.macroTasks.shift();
				task();
			}
		};

		loop();
	}
}

const loop = new EventLoop();

loop.setMicroTask(async () => {
	const post = await fetch("https://jsonplaceholder.typicode.com/posts/1");
	const postData = await post.json();
	console.log(postData, "micro task 1");
	return postData;
});

loop.setTask(() => {
	Promise.resolve().then(() => console.log("Task 2 resolved"));
});

loop.setTask(() => {
	console.log("macro task 2");
});

loop.setTask(() => {
	setTimeout(() => {
		console.log("micro task 1");
	}, 0);
});


loop.setMicroTask(async () => {
	const user = await fetch("https://jsonplaceholder.typicode.com/users/1");
	const userData = await user.json();
	console.log(userData, "micro task 3");
	return userData;
});

loop.setTask(() => {
  console.log("simple tasks")
})

loop.run();
