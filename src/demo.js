(function(){

var shaders = {
    shared: [
        "// Convert an index to an UV-coordinate",
        "vec2 indexToUV(float index, vec2 res){",
        "    vec2 uv = vec2(mod(index/res.x,1.0), floor( index/res.y ) / res.x);",
        "    return uv;",
        "}",

        "// Rotate a vector by a quaternion",
        "vec3 vec3_applyQuat(vec3 v, vec4 q){",
        "    float ix =  q.w * v.x + q.y * v.z - q.z * v.y;",
        "    float iy =  q.w * v.y + q.z * v.x - q.x * v.z;",
        "    float iz =  q.w * v.z + q.x * v.y - q.y * v.x;",
        "    float iw = -q.x * v.x - q.y * v.y - q.z * v.z;",

        "    return vec3(",
        "        ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,",
        "        iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,",
        "        iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x",
        "    );",
        "}"
    ].join('\n'),

    renderParticlesVertex: [
        "uniform sampler2D particleWorldPosTex;",
        "uniform sampler2D quatTex;",
        "attribute float particleIndex;",
        "#define PHONG",
        "varying vec3 vViewPosition;",
        "#ifndef FLAT_SHADED",
        "    varying vec3 vNormal;",
        "#endif",
        "#include <common>",
        "#include <uv_pars_vertex>",
        "#include <uv2_pars_vertex>",
        "#include <displacementmap_pars_vertex>",
        "#include <envmap_pars_vertex>",
        "#include <color_pars_vertex>",
        "#include <fog_pars_vertex>",
        "#include <morphtarget_pars_vertex>",
        "#include <skinning_pars_vertex>",
        "#include <shadowmap_pars_vertex>",
        "#include <logdepthbuf_pars_vertex>",
        "#include <clipping_planes_pars_vertex>",
        "void main() {",
        "    #include <uv_vertex>",
        "    #include <uv2_vertex>",
        "    #include <color_vertex>",
        "    vec2 particleUV = indexToUV(particleIndex,resolution);",
        "#ifdef USE_COLOR",
        "    vColor = vec3((floor(particleUV*3.0)+1.0)/3.0,0);",
        "#endif",
        "    #include <beginnormal_vertex>",
        "    #include <morphnormal_vertex>",
        "    #include <skinbase_vertex>",
        "    #include <skinnormal_vertex>",
        "    vec4 particlePosAndBodyId = texture2D(particleWorldPosTex,particleUV);",
        "    vec2 bodyUV = indexToUV(particlePosAndBodyId.w,bodyTextureResolution);",
        "    vec4 bodyQuat = texture2D(quatTex,bodyUV).xyzw;",
        "    objectNormal.xyz = vec3_applyQuat(objectNormal.xyz, bodyQuat);",
        "#include <defaultnormal_vertex>",
        "#ifndef FLAT_SHADED",
        "    vNormal = normalize( transformedNormal );",
        "#endif",
        "    #include <begin_vertex>",
        "    vec3 particlePos = particlePosAndBodyId.xyz;",
        "    transformed.xyz = vec3_applyQuat(transformed.xyz, bodyQuat);",
        "    transformed.xyz += particlePos;",
        "    #include <displacementmap_vertex>",
        "    #include <morphtarget_vertex>",
        "    #include <skinning_vertex>",
        "    #include <project_vertex>",
        "    #include <logdepthbuf_vertex>",
        "    #include <clipping_planes_vertex>",
        "    vViewPosition = - mvPosition.xyz;",
        "    #include <worldpos_vertex>",
        "    #include <envmap_vertex>",
        "    #include <shadowmap_vertex>",
        "    #include <fog_vertex>",
        "}"
    ].join('\n'),

    renderDepth: [
        "uniform sampler2D bodyPosTex;",
        "uniform sampler2D bodyQuatTex;",
        "attribute float bodyIndex;",
        "#include <common>",
        "#include <uv_pars_vertex>",
        "#include <displacementmap_pars_vertex>",
        "#include <morphtarget_pars_vertex>",
        "#include <skinning_pars_vertex>",
        "#include <logdepthbuf_pars_vertex>",
        "#include <clipping_planes_pars_vertex>",
        "void main() {",
        "    #include <uv_vertex>",
        "    #include <skinbase_vertex>",
        "    #include <begin_vertex>",

        "    vec2 bodyUV = indexToUV(bodyIndex,bodyTextureResolution);",
        "    vec3 bodyPos = texture2D(bodyPosTex,bodyUV).xyz;",
        "    vec4 bodyQuat = texture2D(bodyQuatTex,bodyUV).xyzw;",
        "    transformed.xyz = vec3_applyQuat(transformed.xyz, bodyQuat);",
        "    transformed.xyz += bodyPos;",

        "    #include <displacementmap_vertex>",
        "    #include <morphtarget_vertex>",
        "    #include <skinning_vertex>",
        "    #include <project_vertex>",
        "    #include <logdepthbuf_vertex>",
        "    #include <clipping_planes_vertex>",
        "}"
    ].join('\n')
};

function Demo(parameters){

    var world, scene, ambientLight, light, camera, controls, renderer;
    var debugMesh, debugGridMesh;
    var controller;
    var boxSize;
    var numParticles;

    init();
    animate();

    function init(){
        var numBodies = numParticles / 2;
        var radius = 1/numParticles * 0.5;
        boxSize = new THREE.Vector3(0.25, 1, 0.25);

        renderer = new THREE.WebGLRenderer();
        renderer.setPixelRatio( 1 );
        renderer.setSize( window.innerWidth, window.innerHeight );
        renderer.shadowMap.enabled = true;
        var container = document.getElementById( 'container' );
        container.appendChild( renderer.domElement );
        window.addEventListener( 'resize', onWindowResize, false );

        stats = new Stats();
        stats.domElement.style.position = 'absolute';
        stats.domElement.style.top = '0px';
        container.appendChild( stats.domElement );

        scene = new THREE.Scene();

        light = new THREE.DirectionalLight();
        light.castShadow = true;
        light.shadow.mapSize.width = light.shadow.mapSize.height = 1024;
        var d = 0.5;
        light.shadow.camera.left = - d;
        light.shadow.camera.right = d;
        light.shadow.camera.top = d;
        light.shadow.camera.bottom = - d;
        light.shadow.camera.far = 100;
        light.position.set(1,1,1);
        scene.add(light);

        ambientLight = new THREE.AmbientLight( 0x222222 );
        scene.add( ambientLight );
        renderer.setClearColor(ambientLight.color, 1.0);

        camera = new THREE.PerspectiveCamera( 30, window.innerWidth / window.innerHeight, 0.01, 100 );
        if(parameters.cameraPosition)
            camera.position.copy(parameters.cameraPosition);
        else
            camera.position.set(0,0.6,1.4);

        // Add controls
        controls = new THREE.OrbitControls( camera, renderer.domElement );
        controls.enableZoom = true;
        controls.target.set(0.0, 0.1, 0.0);
        controls.maxPolarAngle = Math.PI * 0.5;

        world = parameters.create(renderer);

        // Create an instanced mesh for debug spheres
        var sphereGeometry = new THREE.SphereBufferGeometry(world.radius, 8, 8);
        var instances = world.maxParticles;
        var debugGeometry = new THREE.InstancedBufferGeometry();
        debugGeometry.maxInstancedCount = instances;
        for(var attributeName in sphereGeometry.attributes){
            debugGeometry.addAttribute( attributeName, sphereGeometry.attributes[attributeName].clone() );
        }
        debugGeometry.setIndex( sphereGeometry.index.clone() );
        var particleIndices = new THREE.InstancedBufferAttribute( new Float32Array( instances * 1 ), 1, 1 );
        for ( var i = 0, ul = particleIndices.count; i < ul; i++ ) {
            particleIndices.setX( i, i );
        }
        debugGeometry.addAttribute( 'particleIndex', particleIndices );
        debugGeometry.boundingSphere = null;

        // Particle spheres material / debug material - extend the phong shader in three.js
        var phongShader = THREE.ShaderLib.phong;
        var uniforms = THREE.UniformsUtils.clone(phongShader.uniforms);
        uniforms.particleWorldPosTex = { value: null };
        uniforms.quatTex = { value: null };
        var debugMaterial = new THREE.ShaderMaterial({
            uniforms: uniforms,
            vertexShader: shaders.shared + shaders.renderParticlesVertex,
            fragmentShader: phongShader.fragmentShader,
            lights: true,
            defines: {
                //USE_MAP: true,
                bodyTextureResolution: 'vec2(' + world.bodyTextureSize.toFixed(1) + ',' + world.bodyTextureSize.toFixed(1) + ')',
                resolution: 'vec2(' + world.particleTextureSize.toFixed(1) + ',' + world.particleTextureSize.toFixed(1) + ')'
            }
        });
        debugMesh = new THREE.Mesh( debugGeometry, debugMaterial );
        debugMesh.frustumCulled = false;
        var checkerTexture = new THREE.DataTexture(new Uint8Array([255,0,0,255, 255,255,255,255]), 2, 1, THREE.RGBAFormat, THREE.UnsignedByteType, THREE.UVMapping);
        checkerTexture.needsUpdate = true;
        debugMaterial.uniforms.map.value = checkerTexture;
        scene.add(debugMesh);

        initDebugGrid();

        var meshUniforms = THREE.UniformsUtils.clone(phongShader.uniforms);
        meshUniforms.bodyQuatTex = { value: null };
        meshUniforms.bodyPosTex = { value: null };

        // Create a depth material for rendering instances to shadow map
        var customDepthMaterial = new THREE.ShaderMaterial({
            uniforms: THREE.UniformsUtils.merge([
                THREE.ShaderLib.depth.uniforms,
                meshUniforms
            ]),
            vertexShader: shaders.shared + shaders.renderDepth,
            fragmentShader: THREE.ShaderLib.depth.fragmentShader,
            defines: {
                DEPTH_PACKING: 3201,
                bodyTextureResolution: 'vec2(' + world.bodyTextureSize.toFixed(1) + ',' + world.bodyTextureSize.toFixed(1) + ')',
                resolution: 'vec2(' + world.particleTextureSize.toFixed(1) + ',' + world.particleTextureSize.toFixed(1) + ')'
            }
        });

        // interaction
        interactionSphereMesh = new THREE.Mesh(new THREE.SphereBufferGeometry(1,16,16), new THREE.MeshPhongMaterial({ color: 0xffffff }));
        world.getSpherePosition(0, interactionSphereMesh.position);
        scene.add(interactionSphereMesh);
        gizmo = new THREE.TransformControls( camera, renderer.domElement );
        gizmo.addEventListener( 'change', function(){
            if(this.object === interactionSphereMesh){
                world.setSpherePosition(
                    0,
                    interactionSphereMesh.position.x,
                    interactionSphereMesh.position.y,
                    interactionSphereMesh.position.z
                );
            } else if(this.object === debugGridMesh){
                world.broadphase.position.copy(debugGridMesh.position);
            }
        });
        scene.add(gizmo);
        gizmo.attach(interactionSphereMesh);
        interactionSphereMesh.castShadow = true;
        interactionSphereMesh.receiveShadow = true;

        initGUI();
    }

    function onWindowResize() {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize( window.innerWidth, window.innerHeight );
    }

    function animate( time ) {
        requestAnimationFrame( animate );
        updatePhysics( time );
        render();
        stats.update();
    }

    var prevTime, prevSpawnedBody=0;
    function updatePhysics(time){
        var deltaTime = prevTime === undefined ? 0 : (time - prevTime) / 1000;
        if(!controller.paused){
            world.step( deltaTime );
        }
        prevTime = time;
    }

    function initDebugGrid(){
        var w = world.broadphase.resolution.x * world.radius * 2;
        var h = world.broadphase.resolution.y * world.radius * 2;
        var d = world.broadphase.resolution.z * world.radius * 2;
        var boxGeom = new THREE.BoxGeometry( w, h, d );
        var wireframeMaterial = new THREE.MeshBasicMaterial({ wireframe: true });
        debugGridMesh = new THREE.Object3D();
        var mesh = new THREE.Mesh(boxGeom,wireframeMaterial);
        debugGridMesh.add(mesh);
        debugGridMesh.position.copy(world.broadphase.position);
        mesh.position.set(w/2, h/2, d/2);
        scene.add(debugGridMesh);
    }

    function updateDebugGrid(){
        debugGridMesh.position.copy(world.broadphase.position);
    }

    function render() {
        controls.update();

        // Render main scene
        updateDebugGrid();

        debugMesh.material.uniforms.particleWorldPosTex.value = world.particlePositionTexture;
        debugMesh.material.uniforms.quatTex.value = world.bodyQuaternionTexture;

        renderer.render( scene, camera );

        debugMesh.material.uniforms.particleWorldPosTex.value = null;
        debugMesh.material.uniforms.quatTex.value = null;
    }

    function initGUI(){
        controller  = {
            moreObjects: function(){ location.href = "?n=" + (numParticles*2); },
            lessObjects: function(){ location.href = "?n=" + Math.max(2,numParticles/2); },
            paused: false,
            renderParticles: false,
            renderShadows: true,
            gravity: world.gravity.y,
            interaction: 'none',
            sphereRadius: world.getSphereRadius(0)
        };

        function guiChanged() {
            world.gravity.y = controller.gravity;

            // Shadow rendering
            renderer.shadowMap.autoUpdate = controller.renderShadows;
            if(!controller.renderShadows){
                renderer.clearTarget(light.shadow.map);
            }

            // Interaction
            gizmo.detach(gizmo.object);
            scene.remove(debugGridMesh);
            switch(controller.interaction){
            case 'sphere':
                gizmo.attach(interactionSphereMesh);
                break;
            case 'broadphase':
                scene.add(debugGridMesh);
                gizmo.attach(debugGridMesh);
                break;
            }
            var r = controller.sphereRadius;
            interactionSphereMesh.scale.set(r,r,r);
            world.setSphereRadius(0,r);
        }

        gui = new dat.GUI();
        gui.add( world, "stiffness", 0, 5000, 0.1 );
        gui.add( world, "damping", 0, 100, 0.1 );
        gui.add( world, "drag", 0, 1, 0.01 );
        gui.add( world, "friction", 0, 10, 0.001 );
        gui.add( world, "fixedTimeStep", 0, 0.1, 0.001 );
        gui.add( controller, "paused" ).onChange( guiChanged );
        gui.add( controller, "gravity", -2, 2, 0.1 ).onChange( guiChanged );
        gui.add( controller, "moreObjects" );
        gui.add( controller, "lessObjects" );
        gui.add( controller, "renderParticles" ).onChange( guiChanged );
        gui.add( controller, "renderShadows" ).onChange( guiChanged );
        gui.add( controller, 'interaction', [ 'none', 'sphere', 'broadphase' ] ).onChange( guiChanged );
        gui.add( controller, 'sphereRadius', boxSize.x/10, boxSize.x/2 ).onChange( guiChanged );
        guiChanged();

        var raycaster = new THREE.Raycaster();
        var mouse = new THREE.Vector2();
        document.addEventListener('click', function( event ) {
            mouse.x = ( event.clientX / renderer.domElement.clientWidth ) * 2 - 1;
            mouse.y = - ( event.clientY / renderer.domElement.clientHeight ) * 2 + 1;
            raycaster.setFromCamera( mouse, camera );
            var intersects = raycaster.intersectObjects( [interactionSphereMesh] );
            if ( intersects.length > 0 ) {
                controller.interaction = 'sphere';
                gui.updateDisplay();
                guiChanged();
            }
        });
    }

    return {
        world: world
    };
}

window.Demo = Demo;

})();