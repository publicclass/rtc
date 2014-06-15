
build: node_modules components build/build.js
	@:

build/build.js: index.js signal/*.js
	@node_modules/.bin/component build --dev

components: component.json
	@node_modules/.bin/component install --dev

node_modules: package.json
	@npm i

clean:
	rm -fr build components node_modules

# note: requires access to application
# create your own application and update
# example/app.yaml if you want to test it
# for yourself
deploy-app-engine-go:
	(cd examples/app-channel-go && appcfg.py update --oauth2 .)

# note: requires access to application
# create your own application and update
# example/app.yaml if you want to test it
# for yourself
deploy-bridge:
	(cd examples/bridge && appcfg.py update --oauth2 .)

# note: requires app engine sdk to be installed
test-bridge:
	@echo "Open localhost:8083/example.html in your browser"
	@(cd examples/bridge && dev_appserver.py . --port 8083 --clear_datastore --automatic_restart)

# note: requires app engine sdk to be installed
test-app-chan-go:
	@echo "Open localhost:8081/xyz in your browser"
	@(cd examples/app-channel-go && dev_appserver.py . --port 8081 --clear_datastore --automatic_restart)

# note: requires node.js to be installed
test-web-socket: node_modules
	@echo "Open localhost:8082/example.html in your browser"
	@(cd examples/web-socket && node relay.js &)
	@(cd examples/web-socket && node_modules/.bin/static -p 8082)

.PHONY: clean test-bridge test-app-chan-go test-web-socket \
				deploy-app-engine-go deploy-app-engine-py
