
build: components index.js
	@node_modules/.bin/component build --dev

components: node_modules component.json
	@node_modules/.bin/component install --dev

node_modules: package.json
	@npm i

clean:
	rm -fr build components template.js

# note: requires access to application
# create your own application and update
# example/app.yaml if you want to test it
# for yourself
deploy-app-engine:
	(cd example && appcfg.py update --oauth2 .)

# note: requires app engine sdk to be installed
test-app-chan:
	@echo "Open localhost:8081/xyz in your browser"
	@(cd example && dev_appserver.py . --port 8081 --clear_datastore --automatic_restart)

# note: requires node.js to be installed
test-ws: node_modules
	@echo "Open localhost:8002/example-ws.html in your browser"
	@(cd example && node relay.js &)
	@(cd example && static -p 8002)

.PHONY: clean
